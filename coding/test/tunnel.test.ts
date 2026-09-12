import { describe, expect, it, vi } from "vitest";
import { logger } from "../src/server/logger";
import { TunnelManager, type OutageCause } from "../src/server/tunnel/manager";
import {
  TunnelClientMissingError,
  type Provider,
  type TunnelProcess,
} from "../src/server/tunnel/provider";

// 阶段3：公网通道状态机测试。全部用假 provider + 虚拟时钟，不碰真实进程、不联网。
// 覆盖 PRD §5.1「公网中断超 15 秒结束会话」与 §4「隧道停止/换域名 → 旧链接失效」。

class FakeProcess implements TunnelProcess {
  readonly kind = "cloudflared";
  readonly url: Promise<string>;
  readonly exited: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>;
  stopped = false;
  private settleUrl!: (v: string) => void;
  private failUrl!: (e: Error) => void;
  private settleExit!: (v: {
    code: number | null;
    signal: NodeJS.Signals | null;
  }) => void;

  constructor() {
    this.url = new Promise((resolve, reject) => {
      this.settleUrl = resolve;
      this.failUrl = reject;
    });
    this.exited = new Promise((resolve) => {
      this.settleExit = resolve;
    });
    // 没被 race 到的分支也可能 reject，先挂个空 catch 免生未处理拒绝
    this.url.catch(() => undefined);
  }

  resolve(url: string): void {
    this.settleUrl(url);
  }

  rejectUrl(err: Error): void {
    this.failUrl(err);
  }

  exit(code: number | null = 1): void {
    this.settleExit({ code, signal: null });
  }

  stop(): void {
    this.stopped = true;
    this.exit(0);
  }
}

function fakeProvider(procs: TunnelProcess[]): Provider {
  let i = 0;
  return {
    kind: "cloudflared",
    describe: "fake",
    start: () => {
      const proc = procs[Math.min(i, procs.length - 1)];
      i += 1;
      return proc;
    },
  };
}

function throwingProvider(err: Error): Provider {
  return {
    kind: "cloudflared",
    describe: "fake",
    start: () => {
      throw err;
    },
  };
}

interface Harness {
  manager: TunnelManager;
  healthCheck: ReturnType<typeof vi.fn>;
  endAllSessions: ReturnType<typeof vi.fn>;
  advance: (ms: number) => Promise<void>;
  settle: () => Promise<void>;
}

function harness(opts: {
  provider: Provider | null;
  health?: (url: string) => Promise<boolean>;
  end?: (cause: OutageCause) => number;
}): Harness {
  let clock = Date.parse("2026-01-01T00:00:00.000Z");
  let nextId = 1;
  let timers: Array<{ id: number; at: number; fn: () => void }> = [];
  const setTimer = (fn: () => void, ms: number) => {
    const id = nextId++;
    timers.push({ id, at: clock + ms, fn });
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  const clearTimer = (t: ReturnType<typeof setTimeout>) => {
    const id = t as unknown as number;
    timers = timers.filter((x) => x.id !== id);
  };
  const settle = async () => {
    for (let n = 0; n < 12; n++) await Promise.resolve();
  };
  const advance = async (ms: number) => {
    const target = clock + ms;
    while (clock < target) {
      clock = Math.min(clock + 100, target);
      const due = timers.filter((x) => x.at <= clock);
      timers = timers.filter((x) => x.at > clock);
      for (const t of due) t.fn();
      await settle();
    }
  };

  const healthCheck = vi.fn(opts.health ?? (async () => true));
  const endAllSessions = vi.fn(opts.end ?? (() => 0));
  const manager = new TunnelManager({
    provider: opts.provider,
    healthCheck: healthCheck as never,
    endAllSessions: endAllSessions as never,
    now: () => new Date(clock),
    setTimer,
    clearTimer,
    // 探活节奏也走虚拟时钟：否则「等 DNS 生效」这种 60 秒窗口在测试里就是 60 秒真等待
    sleep: (ms: number) =>
      new Promise<void>((resolve) =>
        setTimer(() => resolve(), ms),
      ) as Promise<void> & { __done?: unknown },
  });
  return { manager, healthCheck, endAllSessions, advance, settle };
}

describe("重连预算不能永远还满（阶段五真机发现的无限抖动）", () => {
  /** 每次 start 都发一个新 FakeProcess，供测试逐轮控制「给地址 → 掉线」。 */
  function factory(list: FakeProcess[]) {
    let i = 0;
    return {
      kind: "cloudflared" as const,
      describe: "fake",
      start: () => {
        const proc = list[i] ?? list[list.length - 1];
        i += 1;
        return proc;
      },
    } satisfies Provider;
  }

  it("每轮都「验证可达后掉线」时必须进终态，不再无限重连", async () => {
    // 这正是本机日志里跑过的那种：地址分到了、探活了、随后进程退出，
    // 而 markOnline 每次都把 reconnects 清零 —— 预算永远满，永远到不了 UNAVAILABLE。
    const procs: FakeProcess[] = [];
    for (let n = 0; n < 30; n++) procs.push(new FakeProcess());
    const h = harness({ provider: factory(procs), health: async () => true });

    void h.manager.start();
    await h.settle();

    for (let n = 0; n < 12 && h.manager.snapshot().status !== "UNAVAILABLE"; n++) {
      const proc = procs[n];
      proc.resolve(`https://t${n}.trycloudflare.com`);
      await h.settle();
      // 先让本轮被判定为可达，然后再掉线：只有这种循环才会把 reconnects 一直清零
      await h.advance(600);
      proc.exit(1);
      await h.settle();
      await h.advance(20_000); // 走完退避，进入下一轮
    }

    const snap = h.manager.snapshot();
    expect(snap.status).toBe("UNAVAILABLE");
    expect(snap.urlCycles).toBeGreaterThan(0);
    // 文案必须给出路，不能只是「正在重连」
    expect(snap.error).toContain("局域网");
  });

  it("本机探活永远不通、但地址能撑住 60 秒 → 不误判成放弃（代理/DNS 分流那台机器）", async () => {
    // 修「无限重连」很容易改成「更容易放弃」。这条专门盯这个反向错误：
    // 这台机器上真出现过「本机怎么都探不通、链接在别人网络上完全能用」。
    const procs: FakeProcess[] = [];
    for (let n = 0; n < 20; n++) procs.push(new FakeProcess());
    const h = harness({ provider: factory(procs), health: async () => false });

    void h.manager.start();
    await h.settle();

    for (let n = 0; n < 8; n++) {
      const proc = procs[n];
      proc.resolve(`https://slow${n}.trycloudflare.com`);
      await h.settle();
      // 地址撑住 60 秒以上再掉：这一轮该被当成「链路是好的」
      await h.advance(70_000);
      proc.exit(1);
      await h.settle();
      await h.advance(20_000);
    }

    const snap = h.manager.snapshot();
    // 关键是「没被判死」：八轮稳定 60 秒之后还在正常重连，没有走到终态。
    // （刚掉线的那一轮会让计数 +1，这是对的；要盯的是它没一路涨到放弃。）
    expect(snap.status).not.toBe("UNAVAILABLE");
    expect(snap.reconnects).toBeLessThanOrEqual(1);
    expect(snap.urlCycles).toBeLessThanOrEqual(1);
  });

  it("抖过一次之后，新地址又稳又可达 → 抖动计数必须还得回去", async () => {
    // 真机上先跑出来的就是这个：flap=1 之后再也不归零。原因是两处「只看 reconnects」
    // 的短路（验证可达时取消了 60 秒定时器 + 定时器里 reconnects 为 0 就直接 return）。
    // 一条长期健康的链接不该背着历史抖动计数走到放弃。
    const procs: FakeProcess[] = [];
    for (let n = 0; n < 6; n++) procs.push(new FakeProcess());
    const h = harness({ provider: factory(procs), health: async () => true });
    void h.manager.start();
    await h.settle();

    // 第一轮：可达之后掉线 → 记下一次抖动
    procs[0].resolve("https://flap.trycloudflare.com");
    await h.settle();
    await h.advance(500);
    procs[0].exit(1);
    await h.settle();
    await h.advance(5_000);
    expect(h.manager.snapshot().urlCycles).toBe(1);

    // 第二轮：地址撑过 60 秒（期间已验证可达）→ 抖动计数应归零
    procs[1].resolve("https://steady.trycloudflare.com");
    await h.settle();
    await h.advance(70_000);
    const snap = h.manager.snapshot();
    expect(snap.urlCycles).toBe(0);
    expect(snap.reconnects).toBe(0);
    expect(snap.status).toBe("ONLINE");
  });

  it("「45 秒内没等到地址」不再被说成「客户端已退出」", async () => {
    const proc = new FakeProcess();
    const h = harness({ provider: fakeProvider([proc]) });
    void h.manager.start();
    await h.settle();

    proc.rejectUrl(
      new Error("TUNNEL_CONNECT_TIMEOUT：45000ms 内没等到公网地址"),
    );
    await h.settle();

    const snap = h.manager.snapshot();
    expect(snap.error).toBe("隧道客户端没有按时给出公网地址");
    // 这一型没有退出事实，不该编一个退出码出来
    expect(snap.lastClientExit).toBeNull();
  });

  it("退出情形要能被观察到（脱敏：只有码/信号/当时有没有地址）", async () => {
    const proc = new FakeProcess();
    const h = harness({ provider: fakeProvider([proc]), health: async () => false });
    void h.manager.start();
    await h.settle();

    proc.exit(7);
    await h.settle();

    const snap = h.manager.snapshot();
    // sawUrl=false 是「还没分到地址就退了」——本轮那个「第一次必失败」就是这个形状
    expect(snap.lastClientExit).toEqual({
      code: 7,
      signal: null,
      sawUrl: false,
    });
  });
});


describe("已经验证过的地址，一次超时不算断线", () => {
  // 阈值（TUNNEL_HEALTH_FAIL_THRESHOLD，默认 3）存在的意义就是「连续几次才算挂」。
  // 原来阈值以下那一格也调了 markReachable(false)，于是真机上出现过这样一幕：
  // 19:07:34 验证通过 → 19:08:13 一次超时 → A 的复制按钮当场变灰、链接退回「未验证」。
  it("一次探活失败：结论保持可达，复制门槛不撤", async () => {
    let live = true;
    const proc = new FakeProcess();
    const h = harness({ provider: fakeProvider([proc]), health: async () => live });
    void h.manager.start();
    proc.resolve("https://aaa.trycloudflare.com");
    await h.settle();
    await h.advance(2_000);
    await h.settle();
    expect(h.manager.snapshot().reachable).toBe(true);

    live = false; // 一次抖动
    await h.advance(4_000);
    await h.settle();
    const s = h.manager.snapshot();
    expect(s.reachable).toBe(true);
    expect(s.publicBaseUrl).toBe("https://aaa.trycloudflare.com");
    expect(s.status).toBe("ONLINE"); // 还没进重连
  });

  it("连续失败到阈值才算断线：这时才收回门槛并开始重连", async () => {
    let live = true;
    const proc = new FakeProcess();
    const h = harness({ provider: fakeProvider([proc]), health: async () => live });
    void h.manager.start();
    proc.resolve("https://aaa.trycloudflare.com");
    await h.settle();
    await h.advance(2_000);
    await h.settle();

    live = false;
    // 探活 3 秒一次：连续 3 次才算断线（≈9 秒），再往后要越过 15 秒宽限期才会作废会话
    await h.advance(12_000);
    await h.settle();
    const s = h.manager.snapshot();
    expect(s.reachable).toBe(false);
    // 到阈值就算一次断线，重连计数该动起来（重试后伪进程会再次给出地址、
    // 状态可能回到 ONLINE 再被探下来，所以这里盯计数而不是盯状态词）
    expect(s.reconnects).toBeGreaterThanOrEqual(1);
    // 「断线超 15 秒作废会话」由上面重连预算那一组用例覆盖，这里不重复验。
  });
});

describe("tunnel manager", () => {
  it("上线：拿到地址即 ONLINE；探活通过后才把公网基址给出去", async () => {
    const proc = new FakeProcess();
    const h = harness({ provider: fakeProvider([proc]) });
    const started = h.manager.start();
    await h.settle();
    expect(h.manager.snapshot().status).toBe("STARTING");

    proc.resolve("https://aaa.trycloudflare.com");
    await started;
    await h.settle();

    expect(h.manager.snapshot().status).toBe("ONLINE");
    // 还没探活：地址不给出去（复制按钮这时是灰的）
    expect(h.manager.snapshot().reachable).toBe(false);
    expect(h.manager.snapshot().publicBaseUrl).toBeNull();
    await h.advance(1_000);
    await h.settle();

    const snap = h.manager.snapshot();
    expect(snap.reachable).toBe(true);
    expect(snap.publicBaseUrl).toBe("https://aaa.trycloudflare.com");
    expect(snap.publicUrlSource).toBe("tunnel");
    expect(h.manager.baseUrlForLink()).toEqual({
      base: "https://aaa.trycloudflare.com",
      source: "tunnel",
    });
    // 第一次上线不存在「旧链接失效」
    expect(h.endAllSessions).not.toHaveBeenCalled();
  });

  // 本轮修的第二个坎：本机解析不通自己的隧道域名（代理/DNS 分流很常见）时，
  // 旧逻辑两档地址都不给，A 只能看到一个 127.0.0.1，什么都发不出去。
  it("有地址但本机探不通：地址进 pendingBaseUrl 交给 A 自验，可发链接的门槛不降", async () => {
    const proc = new FakeProcess();
    const h = harness({ provider: fakeProvider([proc]), health: async () => false });
    void h.manager.start();
    proc.resolve("https://aaa.trycloudflare.com");
    await h.advance(5_000);
    await h.settle();

    const snap = h.manager.snapshot();
    // 能发给 B 的那一档仍然为空（复制按钮依旧灰着）
    expect(snap.publicBaseUrl).toBeNull();
    expect(snap.reachable).toBe(false);
    expect(h.manager.baseUrlForLink()).toBeNull();
    expect(h.manager.hasConfirmedPublicBase()).toBe(false);
    // 但地址本身要交给 A，否则他连“自己点开试试”这一步都做不了
    expect(snap.pendingBaseUrl).toBe("https://aaa.trycloudflare.com");

    // 一旦本机验证通过：回到正档，pending 档清空（不留两个地址各说各话）
    h.healthCheck.mockImplementation(async () => true);
    await h.advance(5_000);
    await h.settle();
    const ok = h.manager.snapshot();
    expect(ok.reachable).toBe(true);
    expect(ok.publicBaseUrl).toBe("https://aaa.trycloudflare.com");
    expect(ok.pendingBaseUrl).toBeNull();
  });

  // 这一组盯的是「线上查得出来吗」：以前成功时一句不记、失败时也一句不记，
  // 用户问「公网到底通没通」只能靠手跑复现。
  it("本机验不通要留下日志痕迹，且同一轮地址只记一次（探活是 5 秒一轮）", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const proc = new FakeProcess();
    const h = harness({ provider: fakeProvider([proc]), health: async () => false });
    void h.manager.start();
    proc.resolve("https://aaa.trycloudflare.com");
    await h.settle();
    // 首轮探活那一串等待合计 61.5 秒，所以要越过整个序列才拿得到「这轮验不通」的结论
    await h.advance(90_000);
    await h.settle();

    const hits = warn.mock.calls.filter((c) =>
      String(c[0]).includes("not reachable"),
    );
    expect(hits).toHaveLength(1);
    // 只带失败类型码，绝不带地址
    expect(hits[0][1]).toEqual({ tunnelProbeError: "UNKNOWN" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("aaa.trycloudflare");
    warn.mockRestore();
  });

  it("验证通过也要留一条痕迹，同样不带域名", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const proc = new FakeProcess();
    const h = harness({ provider: fakeProvider([proc]), health: async () => true });
    void h.manager.start();
    proc.resolve("https://aaa.trycloudflare.com");
    await h.settle();
    await h.advance(2_000);
    await h.settle();

    const hits = info.mock.calls.filter((c) =>
      String(c[0]).includes("verified reachable"),
    );
    expect(hits).toHaveLength(1);
    expect(JSON.stringify(info.mock.calls)).not.toContain("aaa.trycloudflare");
    info.mockRestore();
  });

  it("provider 为 null（配了固定公网基址）→ DISABLED，且不碰任何进程", async () => {
    const h = harness({ provider: null });
    await h.manager.start();
    expect(h.manager.snapshot().status).toBe("DISABLED");
    expect(h.manager.snapshot().provider).toBeNull();
  });

  it("没装客户端：翻译成人话 + 退避重连，从没给过公网链接就不删会话", async () => {
    const h = harness({
      provider: throwingProvider(new TunnelClientMissingError("no binary")),
    });
    await h.manager.start();
    await h.settle();
    expect(h.manager.snapshot().status).toBe("RECONNECTING");
    expect(h.manager.snapshot().error).toContain("prepare-cloudflared");
    // 重试次数用完（每次 advance 触发一个 backoff 定时器）
    await h.advance(120_000);
    expect(h.manager.snapshot().status).toBe("UNAVAILABLE");
    expect(h.endAllSessions).not.toHaveBeenCalled();
  });

  it("探活不通：不判隧道死刑，只把地址收着不给出去", async () => {
    // 真实踩过的坑：新分配的 trycloudflare 域名在头几十秒里可能 DNS 还没生效（或本机被代理挡住），
    // 早期实现据此反复重启隧道，每次换一个新域名 → 又踩一次同样的窗口，永远出不来链接。
    const procs = [new FakeProcess(), new FakeProcess()];
    const h = harness({
      provider: fakeProvider(procs),
      health: async () => false,
    });
    const started = h.manager.start();
    await h.settle();
    procs[0]!.resolve("https://aaa.trycloudflare.com");
    await started;
    await h.advance(70_000);
    await h.settle();

    expect(h.manager.snapshot().status).toBe("ONLINE"); // 隧道进程活着，状态不因探活失败而退档
    expect(h.manager.snapshot().reachable).toBe(false);
    expect(h.manager.snapshot().publicBaseUrl).toBeNull(); // 没验证通的地址不给分享
    expect(h.manager.snapshot().error).toContain("手机"); // 给 A 的话要说清楚“可能是本机网络问题”
    expect(procs[0]!.stopped).toBe(false); // 关键：不杀进程
    expect(procs.length === 2 ? procs[1]!.stopped : true).toBe(false); // 也没有偷偷重启第二条隧道
    expect(h.healthCheck.mock.calls.length).toBeGreaterThan(3); // 一直在后台重试
    // 没验证通的地址连拼链接都不给用，所以创建会话时会自动退回本机地址，
    // 而不是把一条可能是空号的公网地址发到群里。
    expect(h.manager.baseUrlForLink()).toBeNull();
  });

  it("验证不通之后放慢重验节奏：不再 3 秒一次砸 DNS（自测实测会把负缓存一直续住）", async () => {
    const proc = new FakeProcess();
    const h = harness({
      provider: fakeProvider([proc]),
      health: async () => false,
    });
    const started = h.manager.start();
    await h.settle();
    proc.resolve("https://slow.trycloudflare.com");
    await started;
    await h.advance(62_000); // firstProbe 那一串快节奏走完，重验循环接手
    expect(h.manager.snapshot().status).toBe("ONLINE");
    expect(h.manager.snapshot().reachable).toBe(false);

    const before = h.healthCheck.mock.calls.length;
    await h.advance(5_000);
    expect(h.healthCheck.mock.calls.length).toBe(before); // 5 秒内不该再多问一次
    await h.advance(12_000);
    expect(h.healthCheck.mock.calls.length).toBe(before + 1); // 10 秒一档
  });

  it("被 Cloudflare 限流：不重试、直接停下等人，文案要给等待时间", async () => {
    // 限流时继续重连只会把封禁窗口拉长（阶段3 自测连开十几条隧道就是这么踩到的），
    // 所以这条路径必须和「客户端退出」分开：一个该重试，一个不该。
    const procs = [
      new FakeProcess(),
      new FakeProcess(),
      new FakeProcess(),
      new FakeProcess(),
      new FakeProcess(),
    ];
    let i = 0;
    const provider: Provider = {
      kind: "cloudflared",
      describe: "fake",
      start: () => {
        const proc = procs[Math.min(i, procs.length - 1)];
        i += 1;
        // 只允许第一次创建：用来断言「限流后不再自动重试」
        setTimeout(
          () =>
            proc.rejectUrl(
              new Error(
                "TUNNEL_RATE_LIMITED：Cloudflare 暂时限流了公网地址创建接口",
              ),
            ),
          0,
        );
        return proc;
      },
    };
    const h = harness({ provider });
    await h.manager.start();
    await h.settle();
    await h.advance(120_000);
    expect(h.manager.snapshot().status).toBe("UNAVAILABLE");
    expect(h.manager.snapshot().error).toContain("限流");
    expect(i).toBe(1); // 一次都没自动重试
  });

  it("recheck：A 手动「再验一次」只重跑探活，不换域名、不作废链接", async () => {
    const proc = new FakeProcess();
    let up = false;
    const h = harness({
      provider: fakeProvider([proc]),
      health: async () => up,
    });
    const started = h.manager.start();
    await h.settle();
    proc.resolve("https://recheck.trycloudflare.com");
    await started;
    await h.advance(62_000);
    expect(h.manager.snapshot().reachable).toBe(false);

    up = true; // 手机验证过了 / 本机 DNS 缓过来了
    const snap = await h.manager.recheck();
    expect(snap.reachable).toBe(true);
    expect(snap.publicBaseUrl).toBe("https://recheck.trycloudflare.com");
    expect(h.endAllSessions).not.toHaveBeenCalled(); // 再验一次绝不该动会话
    expect(proc.stopped).toBe(false); // 也不该偷偷重启隧道
  });

  it("曾经可达过、之后连续探活失败：这才算真断线，走重连", async () => {
    const procs = [new FakeProcess(), new FakeProcess()];
    let up = true;
    const h = harness({
      provider: fakeProvider(procs),
      health: async () => up,
    });
    const started = h.manager.start();
    await h.settle();
    procs[0]!.resolve("https://aaa.trycloudflare.com");
    await started;
    await h.advance(1_000);
    expect(h.manager.snapshot().reachable).toBe(true);

    up = false;
    await h.advance(15_000); // 超过连续失败阈值
    expect(h.manager.snapshot().reachable).toBe(false);
    expect(h.manager.snapshot().status).toBe("RECONNECTING");
    expect(procs[0]!.stopped).toBe(true);
  });

  it("上线后进程意外退出：先进重连，断线满 15 秒才结束会话", async () => {
    const procs = [new FakeProcess(), new FakeProcess()];
    const h = harness({
      provider: fakeProvider(procs),
      end: () => 3,
    });
    const started = h.manager.start();
    await h.settle();
    procs[0]!.resolve("https://aaa.trycloudflare.com");
    await started;
    await h.settle();
    expect(h.manager.snapshot().status).toBe("ONLINE");

    // 隧道进程挂了
    procs[0]!.exit(2);
    await h.settle();
    expect(h.manager.snapshot().status).toBe("RECONNECTING");
    // 15 秒以内：链接只是「重连中」，会话还得留着
    await h.advance(10_000);
    expect(h.endAllSessions).not.toHaveBeenCalled();
    // 超过宽限期
    await h.advance(10_000);
    expect(h.endAllSessions).toHaveBeenCalledWith("TUNNEL_DOWN");
    expect(h.manager.snapshot().linkInvalidatedAt).not.toBeNull();
    expect(h.manager.snapshot().sessionsCleaned).toBe(3);
  });

  it("重连后换了域名：旧链接立刻作废", async () => {
    const procs = [new FakeProcess(), new FakeProcess()];
    const h = harness({ provider: fakeProvider(procs), end: () => 1 });
    const started = h.manager.start();
    await h.settle();
    procs[0]!.resolve("https://aaa.trycloudflare.com");
    await started;
    await h.settle();
    expect(h.manager.snapshot().status).toBe("ONLINE");
    h.endAllSessions.mockClear();

    // 手动重连：Quick Tunnel 会给一个新域名，旧域名随之消失
    const reconnecting = h.manager.reconnect();
    await h.settle();
    procs[1]!.resolve("https://bbb.trycloudflare.com");
    await h.advance(2_000); // 等新地址探活通过，地址才会被给出去
    await reconnecting;
    await h.settle();
    expect(h.manager.snapshot().publicBaseUrl).toBe(
      "https://bbb.trycloudflare.com",
    );
    expect(h.endAllSessions).toHaveBeenCalledWith("TUNNEL_URL_CHANGED");
    // 手动重连不该先记一笔「用户主动停止」——那是同一次操作的同一个原因
    expect(h.endAllSessions).not.toHaveBeenCalledWith("TUNNEL_STOPPED");
  });

  it("主动 stop()：链接基址清空 + 会话结束，状态回到 STOPPED", async () => {
    const proc = new FakeProcess();
    const h = harness({ provider: fakeProvider([proc]), end: () => 2 });
    const started = h.manager.start();
    await h.settle();
    proc.resolve("https://aaa.trycloudflare.com");
    await started;
    await h.settle();

    await h.manager.stop();
    expect(h.manager.snapshot().status).toBe("STOPPED");
    expect(proc.stopped).toBe(true);
    expect(h.manager.baseUrlForLink()).toBeNull();
    expect(h.endAllSessions).toHaveBeenCalledWith("TUNNEL_STOPPED");
  });

  it("stop() 之后 start() 可以再来一轮（重连按钮的语义）", async () => {
    const procs = [new FakeProcess(), new FakeProcess()];
    const h = harness({ provider: fakeProvider(procs) });
    const first = h.manager.start();
    await h.settle();
    procs[0]!.resolve("https://aaa.trycloudflare.com");
    await first;
    await h.settle();
    await h.manager.stop();

    const second = h.manager.start();
    await h.settle();
    procs[1]!.resolve("https://ccc.trycloudflare.com");
    await second;
    await h.advance(2_000);
    await h.settle();
    expect(h.manager.snapshot().status).toBe("ONLINE");
    expect(h.manager.snapshot().publicBaseUrl).toBe(
      "https://ccc.trycloudflare.com",
    );
  });

  it("dispose() 之后不再有重连动作（进程退出时不留孤儿）", async () => {
    const procs = [new FakeProcess(), new FakeProcess()];
    const h = harness({ provider: fakeProvider(procs) });
    const started = h.manager.start();
    await h.settle();
    procs[0]!.resolve("https://aaa.trycloudflare.com");
    await started;
    await h.settle();
    procs[0]!.exit(1);
    await h.settle();
    h.manager.dispose();
    await h.advance(60_000);
    // 不会再拉起第二个进程，也不会再进 ONLINE
    expect(procs[1]!.stopped).toBe(false);
    expect(h.manager.snapshot().status).not.toBe("ONLINE");
  });
});

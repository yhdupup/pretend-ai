import { config } from "../config.js";
import { logger } from "../logger.js";
import type { Provider, TunnelProcess } from "./provider.js";
import type {
  LinkInvalidatedReason,
  PublicUrlSource,
  TunnelSnapshot,
  TunnelStatus,
} from "../../shared/types.js";

// 阶段3：公网通道状态机（PRD §5.1 §10 §16.6）。
//
// 状态流转：STOPPED → STARTING → ONLINE →(进程挂了/探活连续失败) RECONNECTING →(退避重连) ONLINE
//                                                     ↘(重试用完) UNAVAILABLE
//
// 五条硬规则：
//  1. 断线超过 TUNNEL_DOWN_GRACE_SECONDS（默认 15 秒）→ 本次会话必须结束（PRD §5.1「公网隧道持续中断超过 15 秒」）。
//  2. 重连后域名变了 → 旧链接物理上不可能再通，先结束会话再上新地址（Quick Tunnel 每次域名都变，等于每次断线都重来）。
//  3. 显式 stop()（或程序退出）→ 链接失效，同样结束会话。
//  4. 「拿到地址」和「地址可用」是两件事：地址一到手就进 ONLINE（cloudflared 只在边缘注册成功后才打印它），
//     但「可用」只认自己探活的结果，用 reachable 单独表示；A 界面的复制按钮看的是 reachable。
//  5. 探活失败 ≠ 隧道进程退出，**绝不因为探活失败就杀隧道进程**。
//     真实环境里出现过：新分配 trycloudflare 域名的头几十秒本机 DNS 解析不到（负缓存窗口），
//     此时隧道本身是好的、B 用自己手机网络完全打得开；早期版本据此反复重连，
//     每次都换个新域名 → 又踩一次同样的窗口，循环十几分钟链接都出不来。
//     所以首次可达之前，探活只是「后台重试到通为止」；可达之后连续失败才算真出问题（规则见 healthLoop）。
//
// 两个「不伤害本地开发」的例外（详见阶段三文档 §四）：
//  - 隧道「从来没给出过地址」时不删会话：否则关掉隧道的本机开发（A 直接开 127.0.0.1 的 B 页面）会被看门狗扫光。
//  - 探活失败不杀进程（规则 5）。

/** 链接作废的原因，与 shared/types 保持同一份定义。 */
export type OutageCause = LinkInvalidatedReason;

export interface TunnelManagerDeps {
  provider: Provider | null;
  /** 探活：给公网基址，返回是否真的能访问到 B 入口。 */
  healthCheck: (baseUrl: string) => Promise<boolean>;
  /** 链接作废的善后：结束所有会话并留下原因，返回条数。 */
  endAllSessions: (cause: OutageCause) => number;
  /** 拿到新地址时的回调（生产接线用于触发隧道侧预热，测试用于观察时序）。 */
  onUrl?: (url: string) => void;
  /** 测试可注入时钟与定时器。 */
  now?: () => Date;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (t: ReturnType<typeof setTimeout>) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** 只保留协议 + 域名 + 端口，去掉尾部斜杠；不是合法 http(s) 就当没配。 */
function normalizeUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];
// 一个地址能连续撑住 60 秒，就认为链路是真通了，把重连预算还回去。
const STABLE_RESET_MS = 60_000;
// 拿到地址后第一次探活的节奏（毫秒）：前密后疏，总计约 60 秒，
// 足够跨过 trycloudflare 新域名的 DNS 生效/负缓存窗口。
const FIRST_PROBE_WAITS_MS = [
  500, 1000, 2000, 3000, 5000, 8000, 12000, 15000, 15000,
];

/** 识别隧道客户端的“被限流”失败（provider 把 stderr 收成一个固定前缀，不回原文）。 */
function isRateLimited(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith("TUNNEL_RATE_LIMITED");
}

/** 同上，认「等不到地址」这一型：它不代表客户端退出，进程可能还好端端地在试。 */
function isConnectTimeout(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith("TUNNEL_CONNECT_TIMEOUT");
}
// 已可达之后的例行探活间隔，与「连续失败几次算真断线」。
const HEALTH_INTERVAL_MS = 3000;
// 有地址但本机验证不通时的重验节奏：故意放慢。10s 一次足够让 A 在几秒内看到绿点，
// 又不至于把本机 DNS 的负缓存一直续命（阶段3 自测实测：每 3s 一次会让解析不通一直好不了）。
const VERIFY_RETRY_MS = 10_000;

/** 把内部错误换成给 A 看的中文短句；细节留在进程里，不回显第三方 stderr。 */
function userMessage(code: string): string {
  switch (code) {
    case "TUNNEL_CLIENT_MISSING":
      return "隧道客户端未安装：运行 npm run prepare-cloudflared 自动下载，或 brew install cloudflared";
    case "TUNNEL_CONNECT_TIMEOUT":
      return "隧道客户端没有按时给出公网地址";
    case "TUNNEL_SPAWN_FAILED":
      return "隧道客户端无法启动";
    case "TUNNEL_EXITED_EARLY":
      return "隧道客户端已退出";
    case "TUNNEL_RATE_LIMITED":
      // 阶段3 自测连开十几条隧道踩到的：Cloudflare 会对建立请求限流（429/1015），
      // 这时候拼命重试只会多等，所以这里不自动重连。
      return "公网地址创建太频繁，Cloudflare 暂时限流了：已停止自动重试，过几分钟再点这里的重试按钮（连着点只会更久）。急着用的话，同一局域网直接用本机地址给对面打开也行";
    // 本机解析不到公网域名：多半是代理/DNS 分流问题，链接本身常常是好的，让用户拿手机验证。
    case "TUNNEL_HEALTH_DNS":
      return "本机解析不到这个公网域名（常见于代理或 DNS 分流），链接本身可能已经可用，换手机流量打开验证一下";
    case "TUNNEL_HEALTH":
      return "公网地址已就绪，但本机暂时访问不通（可能是本机 DNS 或代理限制）。链接本身可能已经可用，可以用手机流量打开验证";
    case "TUNNEL_RETRY_EXHAUSTED":
      return "公网通道多次重连失败，请点「重试」或重启程序";
    case "TUNNEL_URL_FLAPPING":
      // 上游能分到地址但每次都很快掉。这时候最有用的一句话是「先用局域网」，
      // 不是「正在重连」——继续换域名只会把 A 刚发出去的链接一次次作废。
      return "公网地址反复失效（本机这边试了几轮都没稳住）。先点「重试」再试一次；急着用的话，同一台电脑/同一个局域网直接用下面的本机地址给对面打开也行";
    default:
      return "公网通道异常";
  }
}

export class TunnelManager {
  private status: TunnelStatus;
  /** 隧道当前给出的地址；配置里的固定公网基址不存这里（见 effectiveBase）。 */
  private baseUrl: string | null = null;
  /** 上一次用过的地址，用来判断「重连后换域名」。stop() 会清当前地址，这条记忆留着。 */
  private lastUrl: string | null = normalizeUrl(config.publicBaseUrl ?? "");
  private lastError: string | null = null;
  /** 最近一次探活结果。false 表示「有地址但本机验证不通」，不表示隧道挂了。 */
  private reachable = false;
  /** 最近一次探活失败的类型（DNS / PROXY / TIMEOUT / HTTP_1033…），不含域名。 */
  private probeErrorCode: string | null = null;
  private checkedAt: Date | null = null;
  /** 本次运行是否曾经验证可达：只有验证过，后续探活失败才有资格算断线。 */
  private everReachable = false;
  private healthFailures = 0;
  /** 重连预算。复位条件是「这个地址被验证可达过」或「地址撑住了 60 秒」，
   * 不再是「拿到过地址」——见 markOnline / markReachable 的注释。 */
  private reconnects = 0;
  /** 本次进程生命周期里「分到过地址、随后又掉」的轮数。专治无限抖动。 */
  private urlCycles = 0;
  /** 当前这个地址有没有被本机验证可达（每次换地址重新计）。 */
  private currentUrlVerified = false;
  /** 地址连续撑住这么久，就把重连预算还回去（详见 armStableReset）。 */
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  /** 每个地址只记一次「验证通过」/「本机验不通」：探活是 5 秒一轮的循环，
   *  不阅的话日志会被同一件事刷满；而不记的话「今天到底通过没有」事后根本查不出来。
   *  两个开关都在 markOnline（= 换了新地址）时重设。 */
  private verifiedLogged = false;
  private probeFailLogged = false;
  /** 最近一次隧道客户端退出的情形，只存脱敏字段：退出码/信号/当时有没有拿到地址。 */
  private lastClientExit: {
    code: number | null;
    signal: string | null;
    sawUrl: boolean;
  } | null = null;
  private since: Date;
  private onlineSince: Date | null = null;
  private linkInvalidatedAt: Date | null = null;
  private sessionsCleaned = 0;
  private proc: TunnelProcess | null = null;
  /** 本次运行是否真的给出过公网链接（决定断线要不要作废会话）。 */
  private hadPublicLink = false;
  private offlineSince: Date | null = null;
  private outageCounted = true;
  private stopping = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private healthTimer: ReturnType<typeof setTimeout> | null = null;
  /** 每次 attempt 自增；所有异步回调都比对它，避免旧隧道的回调改新隧道的状态。 */
  private generation = 0;
  private listeners = new Set<() => void>();

  constructor(private deps: TunnelManagerDeps) {
    this.status = deps.provider ? "STOPPED" : "DISABLED";
    this.since = this.now();
  }

  // ---------- 对外 ----------

  snapshot(): TunnelSnapshot {
    const base = this.effectiveBase();
    return {
      status: this.status,
      provider: this.deps.provider?.kind ?? null,
      publicBaseUrl: base?.base ?? null,
      publicUrlSource: base?.source ?? "local-dev",
      reachable: this.reachable || base?.source === "config",
      // 本机验不通不等于地址是空的：把它交给 A 自己判断，但复制门槛不降（见 types 注释）。
      pendingBaseUrl:
        this.baseUrl && !this.reachable && base?.source !== "config"
          ? this.baseUrl
          : null,
      checkedAt: this.checkedAt ? this.checkedAt.toISOString() : null,
      // 只有失败类型（DNS / PROXY / TIMEOUT / HTTP_1033…），不带域名，日志同理
      probeError: this.reachable ? null : this.probeErrorCode,
      reconnects: this.reconnects,
      // 抖动轮数与最近一次退出情形：A 界面和自检台靠它们把
      // 「正在等」和「我们试过一轮地址又掉了」区分开 —— 前者不该被读成后者。
      urlCycles: this.urlCycles,
      lastClientExit: this.lastClientExit,
      error: this.lastError,
      since: this.since.toISOString(),
      onlineSince: this.onlineSince ? this.onlineSince.toISOString() : null,
      linkInvalidatedAt: this.linkInvalidatedAt
        ? this.linkInvalidatedAt.toISOString()
        : null,
      sessionsCleaned: this.sessionsCleaned,
    };
  }

  /** 拼 B 链接用的基址；null 表示还没上公网，调用方退回本机地址。 */
  baseUrlForLink(): { base: string; source: PublicUrlSource } | null {
    return this.effectiveBase();
  }

  /** 地址变化时（A 每 2 秒轮询状态）通知 UI 刷新链接。 */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * 是否已经确定公网基址：配置里有固定基址，或隧道已给出且验证可达。
   * A 界面据此决定「链接可以复制」还是「正在等公网」。
   */
  hasConfirmedPublicBase(): boolean {
    return this.effectiveBase() !== null && this.snapshot().reachable;
  }

  async start(): Promise<TunnelSnapshot> {
    if (!this.deps.provider) {
      this.setStatus("DISABLED");
      return this.snapshot();
    }
    if (this.status === "STARTING" || this.status === "ONLINE")
      return this.snapshot();
    this.stopping = false;
    this.reconnects = 0;
    this.urlCycles = 0;
    this.clearRetry();
    this.clearStableReset();
    await this.attempt();
    return this.snapshot();
  }

  stop(): TunnelSnapshot {
    return this.stopInternal("TUNNEL_STOPPED");
  }

  /**
   * 主动停止：链接作废，会话结束（PRD §4「用户主动停止隧道」）。
   * invalidate 传 null 时只停进程不作废 —— 手动「重连」走这条：
   * 重连必然换新域名，作废动作交给 markOnline 里的 TUNNEL_URL_CHANGED 那一路统一做，
   * 免得同一次重连先记 TUNNEL_STOPPED 再记 TUNNEL_URL_CHANGED 两笔。
   */
  private stopInternal(invalidate: OutageCause | null): TunnelSnapshot {
    this.stopping = true;
    this.generation += 1; // 让在途的探活/重连全部作废
    this.clearRetry();
    this.clearStableReset();
    this.stopWatchdog();
    this.stopHealthLoop();
    const proc = this.proc;
    this.proc = null;
    proc?.stop();
    this.reachable = false;
    if (this.baseUrl) {
      this.clearTunnelUrl();
      if (invalidate && this.hadPublicLink) {
        this.sessionsCleaned = this.closeLink(invalidate);
        this.hadPublicLink = false;
      }
    }
    this.setStatus("STOPPED");
    this.stopping = false;
    return this.snapshot();
  }

  /** 手动重连：先停干净再起（Quick Tunnel 必然换域名）。 */
  async reconnect(): Promise<TunnelSnapshot> {
    this.stopInternal(null);
    return this.start();
  }

  /**
   * 「再验一次」：只重新跑一次探活，不换地址、不作废旧链接。
   * 给本机 DNS / 代理刚恢复、或“手机已打开但本机还没变色”这种时候用。
   * 没拿到过地址时探无可探，直接回当前状态（需要地址请先走 start）。
   */
  async recheck(): Promise<TunnelSnapshot> {
    const url = this.baseUrl;
    if (!url || this.stopping) return this.snapshot();
    const ok = await this.check(url);
    this.markReachable(ok);
    return this.snapshot();
  }

  dispose(): void {
    this.stopping = true;
    this.generation += 1;
    this.clearRetry();
    this.stopWatchdog();
    this.stopHealthLoop();
    this.proc?.stop();
    this.proc = null;
    this.listeners.clear();
  }

  // ---------- 内部 ----------

  private effectiveBase(): { base: string; source: PublicUrlSource } | null {
    const configured = normalizeUrl(config.publicBaseUrl ?? "");
    if (configured) return { base: configured, source: "config" };
    // 隧道地址只在「本机验证可达」后才拿出去拼链接：
    // 验证不通就发给 B，等于把一条可能是空号的地址递出去。
    if (this.baseUrl && this.reachable)
      return { base: this.baseUrl, source: "tunnel" };
    return null;
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private after(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    if (this.deps.setTimer) return this.deps.setTimer(fn, ms);
    const t = setTimeout(fn, ms);
    // 定时器不应该单独把 Node 进程钉住（服务该退就退）
    t.unref?.();
    return t;
  }

  private sleep(ms: number): Promise<void> {
    if (this.deps.sleep) return this.deps.sleep(ms);
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      t.unref?.();
    });
  }

  private setStatus(next: TunnelStatus): void {
    if (this.status === next) return;
    this.status = next;
    this.since = this.now();
    this.notify();
  }

  private notify(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        /* UI 回调失败不应该影响隧道 */
      }
    }
  }

  private clearTunnelUrl(): void {
    this.baseUrl = null;
    this.reachable = false;
  }

  /** 收尾：不再自动重试，等用户自己点。重试用完和被限流都走这里。 */
  private giveUp(code: string): void {
    this.lastError = userMessage(code);
    this.stopWatchdog();
    if (this.hadPublicLink) {
      this.sessionsCleaned = this.closeLink("TUNNEL_DOWN");
      this.hadPublicLink = false;
    }
    this.setStatus("UNAVAILABLE");
  }

  private async attempt(): Promise<void> {
    const provider = this.deps.provider;
    if (!provider || this.stopping) return;
    const generation = ++this.generation;
    this.setStatus(this.reconnects === 0 ? "STARTING" : "RECONNECTING");

    let proc: TunnelProcess;
    try {
      proc = provider.start();
    } catch (err) {
      this.lastError = userMessage(
        err instanceof Error && err.name === "TunnelClientMissingError"
          ? "TUNNEL_CLIENT_MISSING"
          : "TUNNEL_SPAWN_FAILED",
      );
      // 只记错误码，不记 err.message（第三方 stderr 可能带地址/临时凭证）
      logger.warn("tunnel client could not be started");
      this.failAttempt(generation);
      return;
    }
    this.proc = proc;
    this.ensureWatchdog();

    // 拿地址 与 进程退出，谁先来听谁。url 推失败时把原因带下来，好区分“限流”这种不该重试的情况。
    // sawUrl 给 lost() 用：同一个「客户端退出了」，发生在拿到地址之前还是之后，
    // 是完全不同的两件事（前者多半是上游分配慢/超时，后者是链路抖动）。
    let sawUrl = false;
    const lost = (why?: { code: number | null; signal: string | null }) => {
      if (generation !== this.generation || this.proc !== proc || this.stopping)
        return;
      this.proc = null;
      this.lastClientExit = {
        code: why?.code ?? null,
        signal: why?.signal ?? null,
        sawUrl,
      };
      this.lastError = userMessage("TUNNEL_EXITED_EARLY");
      // ⑤ 的修复：退出码、信号、「当时有没有拿到过地址」这三样进日志。
      // 之前这里什么都不记（只有一句中文），所以线上「第一次必失败」查不了，
      // 只能靠手跑 cloudflared 复现。第三方 stderr 原文照旧不落盘 —— 里面会有公网域名。
      logger.warn("tunnel client exited", {
        tunnelExitCode: this.lastClientExit.code,
        tunnelExitSignal: this.lastClientExit.signal,
        tunnelSawUrl: sawUrl,
      });
      this.failAttempt(generation);
    };
    proc.exited.then(
      (r) => lost(r),
      () => lost(),
    );

    // 拿地址 与 进程退出，谁先来听谁。url 推失败时把原因带下来，好区分“限流”这种不该重试的情况。
    const outcome = await Promise.race([
      proc.url.then(
        (url) => ({ kind: "url" as const, url, err: null }),
        (err: unknown) => ({ kind: "error" as const, url: null, err }),
      ),
      proc.exited.then(() => ({
        kind: "exit" as const,
        url: null,
        err: null,
        code: null,
        signal: null,
      })),
    ]);

    if (generation !== this.generation || this.stopping) return;
    if (outcome.kind === "url" && outcome.url) {
      sawUrl = true;
      this.markOnline(outcome.url, generation);
      return;
    }
    if (outcome.kind === "error" && isConnectTimeout(outcome.err)) {
      // 「45 秒内没等到地址」和「进程退了」是两句话，以前都归成后者。
      // A 看到的文案要对得上现象，否则排查方向整个错掉。
      this.lastError = userMessage("TUNNEL_CONNECT_TIMEOUT");
      this.lastClientExit = null;
      this.proc = null;
      proc.stop();
      this.failAttempt(generation);
      return;
    }
    if (outcome.kind === "error" && isRateLimited(outcome.err)) {
      // 限流：马上重试只会多封一会儿，直接停在 UNAVAILABLE 等用户手点
      this.proc = null;
      proc.stop();
      this.stopHealthLoop();
      this.clearTunnelUrl();
      this.clearRetry();
      this.giveUp("TUNNEL_RATE_LIMITED");
      return;
    }
    if (outcome.kind === "exit") {
      lost(outcome);
      return;
    }
    lost();
  }

  /** 拿到地址即视为隧道 ONLINE；可达性交给后台探活结论。 */
  private markOnline(url: string, generation: number): void {
    if (generation !== this.generation || this.stopping) return;
    if (this.hadPublicLink && this.lastUrl && this.lastUrl !== url) {
      // 换域名 = 旧链接作废（PRD §4）
      this.sessionsCleaned = this.closeLink("TUNNEL_URL_CHANGED");
    }
    this.baseUrl = url;
    this.lastUrl = url;
    this.hadPublicLink = true;
    this.reachable = false;
    this.healthFailures = 0;
    // ⚠️ 这里以前是 this.reconnects = 0 —— 本轮修掉的真缺陷。
    // 「分到地址」不等于「地址能用」，用它当复位信号，于是只要隧道能拿到地址、
    // 紧接着又掉，每轮都是「拿到 → 清零 → 掉线 → 预算又是满的」：
    // 实测日志连着 8 次 TUNNEL_DOWN、每 16 秒一次，永远走不到 UNAVAILABLE 终态，
    // A 只能盯着一个不会结束的「重连中」。复位改到 markReachable(true) 和 armStableReset。
    this.currentUrlVerified = false;
    this.verifiedLogged = false;
    this.probeFailLogged = false;
    this.outageCounted = false;
    this.offlineSince = null;
    this.armStableReset(generation);
    if (this.onlineSince === null) this.onlineSince = this.now();
    this.lastError = null;
    this.setStatus("ONLINE");
    this.deps.onUrl?.(url);
    void this.firstProbe(url, generation);
  }

  /**
   * 首次探活：按 FIRST_PROBE_WAITS_MS 的节奏后台重试。
   * 失败不杀进程、不改状态，只把「本机暂时访问不通」这句话给 A 看。
   * 例行探活循环由本函数收尾启动：不能在 firstProbe 同时另开一个 3s 循环，
   * 两个循环叠加会把密度推到每 3s 一次，恰好把新域名的 DNS 负缓存一直维持住。
   */
  private async firstProbe(url: string, generation: number): Promise<void> {
    for (const wait of FIRST_PROBE_WAITS_MS) {
      if (generation !== this.generation || this.stopping) return;
      if (this.baseUrl !== url) return; // 已经换新地址了，这轮结论作废
      await this.sleep(wait);
      if (
        generation !== this.generation ||
        this.stopping ||
        this.baseUrl !== url
      )
        return;
      const ok = await this.check(url);
      if (generation !== this.generation || this.baseUrl !== url) return;
      if (ok) {
        this.markReachable(true);
        this.startHealthLoop();
        return;
      }
    }
    if (generation !== this.generation || this.stopping) return;
    this.markReachable(false);
    this.startHealthLoop(); // 之后按 VERIFY_RETRY_MS 慢节奏接着验；A 点「再验一次」会立刻抢先
  }

  /** 探活：只记录失败「类型」，不记录 URL —— 隧道域名本身不进日志（PRD §18.6）。 */
  private async check(url: string): Promise<boolean> {
    try {
      const ok = (await this.deps.healthCheck(url)) === true;
      this.probeErrorCode = ok ? null : "UNKNOWN";
      return ok;
    } catch (err) {
      this.probeErrorCode = (err as { code?: string }).code ?? "UNKNOWN";
      return false;
    }
  }

  /**
   * 没到阈值的探活失败：故意什么都不做。
   * 不撤销 reachable（否则一次超时就把 A 的复制按钮弄灰）、不写 checkedAt
   * （否则界面那行「最近一次验证…」会看起来在反复失败，而实际上一切正常）、
   * 也不记日志（同一件事连续记三条只会淹掉日志）。“连续 N 次才算断线”是阈门的职责。
   */
  private ignoreTransientProbeFailure(): void {}

  private markReachable(ok: boolean): void {
    this.checkedAt = this.now();
    if (ok) {
      this.reachable = true;
      this.probeErrorCode = null;
      this.healthFailures = 0;
      this.everReachable = true;
      this.offlineSince = null;
      this.outageCounted = false;
      // 验证可达 → 把「重连预算」还满：这是唯一能证明整条链路走通过的信号。
      // ⚠️ 但 urlCycles 这里**不能**跟着清零。抖动恰恰长成「每轮都短暂通一下」的样子，
      // 在这儿清零等于把抖动计数器永久归零 —— 第一版就是这么写的，测试直接没进终态。
      // 抖动计数只在「一个地址撑住 60 秒」（armStableReset）或用户显式 start() 时才还 ——
      // 所以这里**不能**把那个 60 秒定时器取消掉。真机上栽过这一刀：验证可达顺手 clearStableReset，
      // 于是健康在线的会话永远等不到抖动计数归零。
      if (!this.currentUrlVerified) {
        this.currentUrlVerified = true;
        this.reconnects = 0;
        if (!this.verifiedLogged) {
          this.verifiedLogged = true;
          // 只记“通过了”这件事，不记地址：这条就是用户问「公网到底通没通」时的唯一凭据。
          logger.info("tunnel address verified reachable from this machine");
        }
      }
      if (this.lastError) this.lastError = null;
    } else {
      this.reachable = false;
      this.lastError = userMessage(
        this.probeErrorCode === "DNS" ? "TUNNEL_HEALTH_DNS" : "TUNNEL_HEALTH",
      );
      if (!this.probeFailLogged) {
        this.probeFailLogged = true;
        // 只记失败类型码（DNS/PROXY/TIMEOUT/HTTP_xxxx），不记域名：
        // 以前这里一句不记，导致「本机验不通」和「隧道挂了」在日志里长一个样。
        logger.warn("tunnel address not reachable from this machine", {
          tunnelProbeError: this.probeErrorCode ?? "UNKNOWN",
        });
      }
    }
    this.notify();
  }

  /** 例行探活：可达过之后连续失败到阈值才算真断线（PRD §10 探活语义）。 */
  private startHealthLoop(): void {
    if (this.healthTimer !== null) return;
    const tick = async () => {
      this.healthTimer = null;
      if (this.stopping || !this.baseUrl) return;
      const url = this.baseUrl;
      const ok = await this.check(url);
      if (this.baseUrl !== url) return; // 探的是旧地址，结论丢掉
      if (ok) {
        this.markReachable(true);
      } else if (this.everReachable) {
        this.healthFailures += 1;
        if (
          this.healthFailures >= Math.max(1, config.tunnelHealthFailThreshold)
        ) {
          this.markReachable(false);
          this.failAttempt(this.generation); // 只有曾经可用过，才把它当断线
        } else {
          // 没到阈值：这只是一次抖动。下面那一行以前直接 markReachable(false)，
          // 于是一次超时就足以把已经验证过的链接从 A 手里抢回去、把复制按钮弄灰；
          // 而“连续几次才算断线”本来就是阈值该管的事。真机上看到的正是这个抖动：
          // 19:07:34 验证通过，19:08:13 一次超时，界面就从「可复制」退回「未验证」。
          this.ignoreTransientProbeFailure();
        }
      } else {
        // 从没验证成功过：不判罚隧道，只报「本机验证不通」
        this.markReachable(false);
      }
      if (!this.stopping && this.baseUrl)
        this.healthTimer = this.after(
          () => void tick(),
          this.probeIntervalMs(),
        );
    };
    this.healthTimer = this.after(() => void tick(), this.probeIntervalMs());
  }

  /**
   * 探活节奏：验证成功过就 3 秒一次（PRD §5.1 要求断连超 15 秒结束会话，慢不得）；
   * 从没验证成功过说明多半是本机网络问题、不是链路问题，放慢到 10 秒一次，
   * 免得每 3 秒一次查不到把本机 DNS 的负缓存一直续住（那样反而永远验不通）。
   */
  private probeIntervalMs(): number {
    return this.everReachable ? HEALTH_INTERVAL_MS : VERIFY_RETRY_MS;
  }

  private stopHealthLoop(): void {
    if (this.healthTimer !== null) {
      if (this.deps.clearTimer) this.deps.clearTimer(this.healthTimer);
      else clearTimeout(this.healthTimer);
      this.healthTimer = null;
    }
  }

  /** 隧道不可用（进程退出 / 探活判罚）：清地址、按退避重连，重试用完转 UNAVAILABLE。 */
  private failAttempt(generation: number): void {
    if (generation !== this.generation || this.stopping) return;
    const proc = this.proc;
    // 必须在 clearTunnelUrl() 之前问，之后 baseUrl 已经是 null 了。
    const hadUrl = this.baseUrl !== null;
    this.proc = null;
    proc?.stop();
    this.stopHealthLoop();
    this.clearTunnelUrl();
    this.clearStableReset();
    this.onlineSince = null;
    // 这一轮是不是「拿到过地址又掉」？只有那种才算抖动，计入 urlCycles。
    // 从没分到过地址的失败由 reconnects 管，两条预算各有各的终态文案。
    if (hadUrl) this.urlCycles += 1;
    this.offlineSince = this.offlineSince ?? this.now();
    if (this.reconnects >= config.tunnelMaxReconnectAttempts) {
      this.giveUp("TUNNEL_RETRY_EXHAUSTED");
      return;
    }
    if (this.urlCycles >= config.tunnelMaxUrlCycles) {
      // 上游能给地址但每次都不稳：继续试只会不断换域名、不断作废 A 刚发出去的链接。
      // 收手并告诉用户走局域网，比无限重连有用。
      this.giveUp("TUNNEL_URL_FLAPPING");
      return;
    }
    this.ensureWatchdog();
    const delay = BACKOFF_MS[Math.min(this.reconnects, BACKOFF_MS.length - 1)];
    this.reconnects += 1;
    this.setStatus("RECONNECTING");
    this.clearRetry();
    this.retryTimer = this.after(() => {
      this.retryTimer = null;
      void this.attempt();
    }, delay);
  }

  /** 断线看门狗：每 1 秒看一眼，超宽限期就作废链接（每次断线只触发一次）。 */
  private ensureWatchdog(): void {
    if (this.watchdogTimer) return;
    const tick = () => {
      this.watchdogTimer = null;
      const downMs = this.offlineSince
        ? this.now().getTime() - this.offlineSince.getTime()
        : 0;
      const overdue =
        this.status !== "ONLINE" &&
        this.hadPublicLink &&
        !this.outageCounted &&
        downMs > config.tunnelDownGraceSeconds * 1000;
      if (overdue) {
        this.sessionsCleaned = this.closeLink("TUNNEL_DOWN");
        this.hadPublicLink = false;
        this.outageCounted = true;
      }
      if (this.status === "ONLINE" || this.stopping) return;
      this.watchdogTimer = this.after(tick, 1000);
    };
    this.watchdogTimer = this.after(tick, 1000);
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer !== null) {
      if (this.deps.clearTimer) this.deps.clearTimer(this.watchdogTimer);
      else clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) {
      if (this.deps.clearTimer) this.deps.clearTimer(this.retryTimer);
      else clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /**
   * 地址连续撑住 60 秒没掉 → 把重连预算还回去。
   *
   * 为什么光靠 markReachable 不够：这台机器上真出现过「本机探活怎么都探不通
   * （代理/DNS 分流），但链接在别人的网络上完全能用」的状态（文件头规则 5）。
   * 只按验证可达复位的话，这类机器哪怕公网一切正常，也会在几次抖动后被我们
   * 判成 UNAVAILABLE —— 那就是把「永远不放弃」换成了「更容易放弃」，白改。
   * 所以再加一条不依赖本机探活结论的判据：地址本身撑得够久。
   */
  private armStableReset(generation: number): void {
    this.clearStableReset();
    this.stableTimer = this.after(() => {
      this.stableTimer = null;
      if (generation !== this.generation || this.stopping || !this.baseUrl) return;
      // 两个计数都已经是 0 才没事可做。只看 reconnects 会漏：验证可达已经把它清零了，
      // 剩下的正是抖动计数（真机实测到的那个 flap=1 再也还不回去，就是这么来的）。
      if (this.reconnects === 0 && this.urlCycles === 0) return;
      this.reconnects = 0;
      this.urlCycles = 0;
      logger.info("tunnel held one address long enough, reconnect budget reset");
    }, STABLE_RESET_MS);
  }

  private clearStableReset(): void {
    if (this.stableTimer !== null) {
      if (this.deps.clearTimer) this.deps.clearTimer(this.stableTimer);
      else clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
  }

  /** 一次「链接作废」的收尾：记失效时间 + 结束会话。返回条数。 */
  private closeLink(cause: OutageCause): number {
    this.linkInvalidatedAt = this.now();
    this.clearTunnelUrl();
    this.onlineSince = null;
    const cleaned = this.deps.endAllSessions(cause);
    // 会话条数不是敏感值；隧道地址、子进程输出一律不写日志。
    logger.info(`tunnel ${cause}: ended ${cleaned} session(s)`);
    return cleaned;
  }
}

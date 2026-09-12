import { describe, expect, it } from "vitest";
import {
  actionStates,
  copyDisabledReason,
  linkView,
  shouldShowBaseUrl,
  statusDetail,
  statusFetchErrorText,
} from "../apps/a-frontend/src/public-status";
import type { TunnelSnapshot } from "../src/shared/types";

// A 界面「公网链接」那一小块的文案与副标题。之所以单测：这些句子是 A 判断
// 「该继续等」「该点哪个按钮」「该改走局域网」的唯一依据 —— 写错了比不写更坏，
// 比如让人去点一个界面上根本不存在的按钮。

function snap(over: Partial<TunnelSnapshot> = {}): TunnelSnapshot {
  return {
    status: "ONLINE",
    provider: "cloudflared",
    publicBaseUrl: null,
    publicUrlSource: "tunnel",
    error: null,
    reconnects: 0,
    urlCycles: 0,
    lastClientExit: null,
    reachable: true,
    pendingBaseUrl: null,
    checkedAt: null,
    probeError: null,
    since: "2026-01-01T00:00:00.000Z",
    onlineSince: null,
    linkInvalidatedAt: null,
    sessionsCleaned: 0,
    ...over,
  } as TunnelSnapshot;
}

/** 只给一个 tunnel 拼出 linkView 要的最小 status。 */
function view(tunnel: TunnelSnapshot, path = "abc") {
  return linkView({ localPublicPort: 8788, tunnel } as never, path).reason;
}

describe("公网副标题要把两种失败分开讲", () => {
  it("一切正常时不啰嗦", () => {
    expect(
      statusDetail(snap({ checkedAt: "2026-01-01T00:00:05.000Z" })),
    ).toContain("验证可访问");
  });

  it("拿到过地址又掉：说清换了几轮，并提醒每轮都作废旧链接", () => {
    const text = statusDetail(
      snap({ status: "RECONNECTING", reconnects: 2, urlCycles: 3 }),
    );
    expect(text).toContain("第 2 次重连");
    expect(text).toContain("已试过 3 轮地址");
    expect(text).toContain("作废");
  });

  it("ONLINE 中不播报抖动（正在用的时候别吓 A）", () => {
    expect(statusDetail(snap({ status: "ONLINE", urlCycles: 4 }))).not.toContain(
      "已试过",
    );
  });

  it("客户端没等到地址就退了 —— 这一型要单独点名", () => {
    const text = statusDetail(
      snap({
        status: "RECONNECTING",
        reconnects: 1,
        lastClientExit: { code: 1, signal: null, sawUrl: false },
      }),
    );
    expect(text).toContain("没等到地址");
  });

  it("拿到过地址之后才退的，不套用上面那句", () => {
    const text = statusDetail(
      snap({
        status: "RECONNECTING",
        lastClientExit: { code: null, signal: "SIGTERM", sawUrl: true },
      }),
    );
    expect(text).not.toContain("没等到地址");
  });
});

describe("A 看到的句子要能照着做", () => {
  it("探针不通时把原因类型一起讲出来（只有「失败」两个字等于没说）", () => {
    const text = statusDetail(
      snap({
        status: "ONLINE",
        reachable: false,
        checkedAt: "2026-01-01T00:00:05.000Z",
        probeError: "PROXY",
      }),
    );
    expect(text).toContain("最近一次验证失败");
    expect(text).toContain("本机代理没接通");
  });

  it("认不出的码也别憋着，至少把原码露出来（宁多不错）", () => {
    expect(
      statusDetail(
        snap({
          reachable: false,
          checkedAt: "2026-01-01T00:00:05.000Z",
          probeError: "SOMETHING_NEW",
        }),
      ),
    ).toContain("SOMETHING_NEW");
  });

  it("HTTP_1033 这种一长串码要翻成人话（PRD：给用户看的不该是代码）", () => {
    expect(
      statusDetail(
        snap({
          reachable: false,
          checkedAt: "2026-01-01T00:00:05.000Z",
          probeError: "HTTP_1033",
        }),
      ),
    ).toContain("还没连到本机");
  });

  it("链接作废过就把「已结束几个会话」说清楚，别让 A 以为是对面自己打不开", () => {
    const text = statusDetail(
      snap({
        status: "ONLINE",
        linkInvalidatedAt: "2026-01-01T00:00:09.000Z",
        sessionsCleaned: 2,
      }),
    );
    expect(text).toContain("链接作废");
    expect(text).toContain("2");
  });
});

describe("没有可用地址时的提示要指向界面上真的那个按钮", () => {
  it("未开启 → 让你点「开启公网链接」", () => {
    const reason = view(snap({ status: "STOPPED", reachable: false }));
    expect(reason).toContain("开启公网链接");
    expect(reason).not.toContain("重试");
  });

  it("不可用 → 那个按钮的字样已经变成「重试」，不能再让人找「开启公网链接」", () => {
    const reason = view(snap({ status: "UNAVAILABLE", reachable: false }));
    expect(reason).toContain("重试");
    expect(reason).not.toContain("开启公网链接");
  });
});

describe("本机验不通时，地址要亮着、复制要关着", () => {
  // 这一档是本轮补的：代理/DNS 分流的机器上本机探活常年 false，
  // 而链接其实是好的。原来界面只给 127.0.0.1，A 什么都发不出去。
  const pending = snap({
    status: "ONLINE",
    reachable: false,
    pendingBaseUrl: "https://aaa.trycloudflare.com",
    probeError: "DNS",
  });

  it("给的是真地址，不是只能自己点的 127.0.0.1", () => {
    const v = linkView({ localPublicPort: 8788, tunnel: pending } as never, "abc");
    expect(v.url).toBe("https://aaa.trycloudflare.com/s/abc");
    expect(v.unverified).toBe(true);
    expect(v.reachable).toBe(false);
    expect(v.url).not.toContain("127.0.0.1");
  });

  it("说清「先自己验」，而且把本机不通的原因类型带上", () => {
    const v = linkView({ localPublicPort: 8788, tunnel: pending } as never, "abc");
    expect(v.reason).toContain("先别发给 B");
    expect(v.reason).toContain("手机流量");
    expect(v.reason).toContain("本机解析不到该域名");
  });

  it("复制门槛不能跟着放松（PRD：健康检查通过后才可分享），且原因不能谎称没地址", () => {
    const reason = copyDisabledReason(pending)!;
    expect(reason).toContain("本机没验证通过");
    expect(reason).toContain("手机流量");
    expect(reason).not.toContain("还没有拿到公网地址");
    // 验通了才真正放开，两档不能同时候选
    expect(
      copyDisabledReason(
        snap({ pendingBaseUrl: null, reachable: true, publicBaseUrl: "https://aaa.trycloudflare.com" }),
      ),
    ).toBeNull();
  });

  it("什预都没有时（未开启/还在等）仍退回本机地址档，不能假装有公网", () => {
    const v = linkView(
      { localPublicPort: 8788, tunnel: snap({ status: "STARTING", reachable: false }) } as never,
      "abc",
    );
    expect(v.url).toBe("http://127.0.0.1:8788/s/abc");
    expect(v.unverified).toBe(false);
    expect(v.sourceLabel).toContain("只有你这台电脑能打开");
  });

  // 按钮亮不亮单独拦一组：这类错在真浏览器里才会撞上，而 A 照文案找一个变灰的按钮
  // 比自己读不到地址更难查。
  it("只有未验证地址时，「再验一次」和「换一条链接」必须能点", () => {
    const s = actionStates(pending);
    expect(s.canRecheck).toBe(true);
    expect(s.canSwap).toBe(true);
    expect(s.canStart).toBe(false);
    expect(s.canStop).toBe(true);
  });

  it("已验证可达时「再验一次」让位（没坏就不该引诱人再点）", () => {
    const s = actionStates(
      snap({ publicBaseUrl: "https://aaa.trycloudflare.com", reachable: true }),
    );
    expect(s.canRecheck).toBe(false);
    expect(s.canSwap).toBe(true);
  });

  it("一切正常时公网面板上只剩「停止」和「换一条链接」两个按钮", () => {
    // 作者 2026-09-12：这个板块不需要展示信息，只留这两个动作。
    // 面板现在是「true 才渲染按钮」（不再印四个灰按钮），所以 true 的个数 = 界面上的按钮数。
    const s = actionStates(
      snap({ publicBaseUrl: "https://aaa.trycloudflare.com", reachable: true }),
    );
    const visible = [s.canStart, s.canStop, s.canSwap, s.canRecheck].filter(
      Boolean,
    ).length;
    expect(visible).toBe(2);
    expect(s.canStop && s.canSwap).toBe(true);
  });

  it("重连中全部锁住，不让人对着正在变的地址乱点", () => {
    const s = actionStates(
      snap({ status: "RECONNECTING", reachable: false, pendingBaseUrl: null }),
    );
    expect(s).toEqual({
      canStart: false,
      canStop: true,
      canSwap: false,
      canRecheck: false,
    });
  });

  it("进了终态只能点「重试」，手里没地址时不能点换/验", () => {
    const s = actionStates(
      snap({ status: "UNAVAILABLE", reachable: false, pendingBaseUrl: null }),
    );
    expect(s.canStart).toBe(true);
    expect(s.canSwap).toBe(false);
    expect(s.canRecheck).toBe(false);
  });
});

describe("statusFetchErrorText：状态轮询读不到时要分开「会话失效」与「服务没起来」", () => {
  // 这一组是 2026-09-12 真机补的：A 从书签/历史直接打开 8787，页面壳能开（它免 Cookie），
  // 但每个数据接口 403。原先两种情况都印「读不到通道状态」，A 于是去查公网通道 —— 公网好得很。
  it("403 要说清是控制会话失效，并给出出路（重新走一次性引导链接）", () => {
    const text = statusFetchErrorText({ status: 403 });
    expect(text).toContain("本机控制会话已失效");
    expect(text).toContain("一次性引导链接");
    expect(text).toContain("重新双击启动脚本");
    // 不能把「读不到通道状态」这句含糊话留着：它是这轮要消掉的错
    expect(text).not.toContain("读不到通道状态");
  });

  it("非 403（服务没起来 / 网络断了）不许谎称会话失效", () => {
    for (const err of [
      { status: 500 },
      { status: 0 },
      new TypeError("fetch failed"),
      null,
      undefined,
    ]) {
      expect(statusFetchErrorText(err)).toBe("读不到通道状态");
    }
  });

  it("提示里不含令牌、Cookie 值或绝对路径（PRD §18.6）", () => {
    const text = statusFetchErrorText({ status: 403 });
    expect(text).not.toMatch(/[0-9a-f]{32,}/);
    expect(text).not.toContain("aiwindow_ctrl");
    expect(text).not.toContain("/Users/");
  });
});

// 通道地址（裸域名）显不显示。之所以钉成单测：这是一条产品判定，不是一次样式调整 ——
// 真实病例是 A 把这行域名抄给朋友，朋友在另一台电脑上看到一行 404 Not Found，
// 回来报告「公网链接不可用」。能分享的只有会话卡片上那条 /s/<会话id>。
describe("通道地址只在没验通的时候才亮出来", () => {
  it("已验证可访问 → 藏起来（A 用不上它，只会误发给别人）", () => {
    expect(shouldShowBaseUrl(snap({ publicBaseUrl: "https://a.trycloudflare.com", reachable: true }))).toBe(false);
  });

  it("有地址但本机没验通 → 显示（A 得自己拿手机流量点开它试）", () => {
    expect(shouldShowBaseUrl(snap({ publicBaseUrl: "https://a.trycloudflare.com", reachable: false }))).toBe(true);
  });

  it("只有待验证地址 → 显示", () => {
    expect(shouldShowBaseUrl(snap({ pendingBaseUrl: "https://b.trycloudflare.com" }))).toBe(true);
  });

  it.each([
    ["还没分到地址", snap({})],
    ["状态读取失败", null],
  ])("%s → 没东西可显示", (_name, tunnel) => {
    expect(shouldShowBaseUrl(tunnel as TunnelSnapshot | null)).toBe(false);
  });
});

import type {
  LocalStatusResponse,
  TunnelSnapshot,
  TunnelStatus,
} from "../../../src/shared/types";

// A 前端「公网链接」这一块的全部判断逻辑，抽成纯函数：
// 组件只负责画，状态能不能复制、按钮该显示什么字，都在这里，方便单测和两边复用。

export const STATUS_TEXT: Record<TunnelStatus, string> = {
  STOPPED: "未开启",
  STARTING: "正在建立公网通道…",
  // 只说「地址已就绪」：真正可不可用由 reachable 单独表示，两件事不混在一个词里
  ONLINE: "公网地址已就绪",
  RECONNECTING: "公网连接中断，正在自动重连",
  UNAVAILABLE: "公网通道不可用",
  DISABLED: "使用固定公网地址",
};

export interface LinkView {
  /** 完整可发给 B 的地址。 */
  url: string;
  /** 这条地址是从哪来的：隧道 / 配置 / 只有本机能开。 */
  sourceLabel: string;
  /** 现在点进去 B 能不能打开（服务端探活通过才算）。 */
  reachable: boolean;
  /** 有地址但本机验不通：地址仍然给 A 看，只是不让他当成已验证去分发。 */
  unverified: boolean;
  /** 不能复制时，按钮旁边该写的原因。 */
  reason: string | null;
}

/**
 * 拼出要发给 B 的地址。publicPath 是会话自己带的路径（/s/<id>）。
 * 三档来源（和后端 POST /api/local/sessions 里 publicUrl 的口径一致）：
 * 隧道域名 → 配置里的固定公网基址 → 本机地址。最后一档只能在自己电脑上点，必须标出来，
 * 不然 A 会以为链接已经能发给别人了。
 */
export function linkView(
  status: LocalStatusResponse | null,
  publicPath: string,
): LinkView {
  const path = publicPath.startsWith("/") ? publicPath : `/s/${publicPath}`;
  const tunnel = status?.tunnel ?? null;
  const base = tunnel?.publicBaseUrl ?? null;
  const source = tunnel?.publicUrlSource ?? "local-dev";

  const verified = tunnel?.reachable ?? false;
  if (base && (source === "tunnel" || source === "config")) {
    return {
      url: `${base}${path}`,
      sourceLabel:
        source === "config"
          ? "固定公网地址"
          : "临时公网地址（重连会换域名，旧链接随之作废）",
      reachable: verified,
      unverified: false,
      // 地址已给出但本机探活不通：链接可能是好的（本机 DNS/代理问题），也可能是空号。
      // 两种情况都不该让 A 拿着它当已验证去分发，所以原因写清楚并给一个自助验证办法。
      reason: verified ? null : (tunnel?.error ?? "正在验证这个地址能不能打开"),
    };
  }

  // 本机探活没通过、但隧道确实分到了一条地址：以前这里直接退回 127.0.0.1，
  // 于是「本机解析不通自己域名」（代理/DNS 分流很常见）的机器上 A 什么都发不出去，
  // 只能看到一个注定打不开的地址。现在把真地址显示出来、明说没验证，
  // 但复制按钮仍由 copyDisabledReason 卡着，防呆不降。
  const pending = tunnel?.pendingBaseUrl ?? null;
  if (pending) {
    return {
      url: `${pending}${path}`,
      sourceLabel: "临时公网地址（重连会换域名，旧链接随之作废）",
      reachable: false,
      unverified: true,
      reason: `本机验证这条地址打不通${probeText(tunnel?.probeError ?? null) ? `（${probeText(tunnel?.probeError ?? null)}）` : ""}，先别发给 B：自己用手机流量点开上面的地址试试，能打开就可以发；打不开就点「换一条链接」`,
    };
  }

  return {
    url: `http://127.0.0.1:${status?.localPublicPort ?? 8788}${path}`,
    sourceLabel: "本机地址（只有你这台电脑能打开）",
    reachable: status?.tunnel?.status === "DISABLED",
    unverified: false,
    // 按钮字样随状态变（不可用时显示「重试」），所以这里不能写死「开启公网链接」，
    // 否则 A 照文案找一个界面上不存在的按钮。
    reason:
      (status?.tunnel?.status === "UNAVAILABLE"
        ? "还没有可用的公网地址：点上面的「重试」再试一次"
        : "还没有可用的公网地址：点上面的「开启公网链接」") +
      "，或在 .env.example 里填 PUBLIC_BASE_URL 用固定地址",
  };
}

/**
 * 通道地址（裸域名）要不要显示给 A。抽成函数是为了能被单测钉住 —— 它是一条产品判定，不是样式选择。
 *
 * 为什么要藏：能发给 B 的只有会话卡片上那条 `…/s/<会话id>`，裸地址**不是链接**。
 * 真实病例：A 拄了工作台上这一行域名发到另一台电脑打开 → 对方只看到一行 `404 Not Found`，
 * 以为「公网链接不可用」。地址对 A 只剩一个用处：本机探活不通时，自己拿手机流量点开它试。
 * 所以：验通了就藏，没验通才亮。
 */
export function shouldShowBaseUrl(tunnel: TunnelSnapshot | null): boolean {
  if (!tunnel) return false;
  if (tunnel.publicBaseUrl) return !tunnel.reachable;
  return !!tunnel.pendingBaseUrl;
}

const REASON: Record<TunnelStatus, string> = {
  STOPPED: "公网通道还没开启，链接暂时打不开",
  STARTING: "公网通道正在建立，稍等几秒",
  ONLINE: "",
  RECONNECTING: "公网通道正在重连，恢复前链接打不开",
  UNAVAILABLE: "公网通道建立失败，看下面的原因",
  DISABLED: "公网通道还没开启，链接暂时打不开",
};

/**
 * 复制/分享按钮的门槛：只看「地址 + 探活结论」，不看状态词。
 * PRD 阶段3 的验收口径是「健康检查通过后才可分享」。
 */
// 探活失败类型的中文解释：这几句话决定用户下一步去查代理还是去查隧道。
const PROBE_ERROR: Record<string, string> = {
  DNS: "本机解析不到该域名",
  PROXY: "本机代理没接通",
  TIMEOUT: "请求超时",
  REFUSED: "本机 B 入口没在监听",
  BAD_BODY: "健康检查返回异常",
  // 这条要说得重：地址是活的，但回显对不上，说明打开的不是我们这台机器
  STALE_OR_CACHE:
    "这个地址回的内容不是本机的服务（可能被缓存或被人占用），先别发出去",
  HTTP_1033: "公网地址还没连到本机 B 入口（通常是隧道或 B 服务刚重启）",
};

// 没列出来的 HTTP 状态码也翻成人话：原始码留在接口里给排查用，不给用户看代码。
function probeText(code: string | null): string | null {
  if (!code) return null;
  if (PROBE_ERROR[code]) return PROBE_ERROR[code];
  if (code.startsWith("HTTP_"))
    return `公网地址返回了 HTTP ${code.slice(5)}，不像是本机的服务`;
  return code;
}

export function copyDisabledReason(
  tunnel: TunnelSnapshot | null,
): string | null {
  if (!tunnel) return "正在读取通道状态…";
  if (tunnel.reachable && tunnel.publicBaseUrl) return null;
  if (tunnel.status !== "ONLINE") return REASON[tunnel.status];
  if (!tunnel.publicBaseUrl) {
    // 手里有一条地址但本机验不通：说「没拿到地址」是假的，A 会去等一个已经在屏幕上的东西。
    if (tunnel.pendingBaseUrl)
      return "这条地址本机没验证通过，先自己用手机流量点开确认，验证通过后才能复制";
    return "还没有拿到公网地址";
  }
  return "这个地址还没通过访问验证，验证通过后才能复制";
}

/** 状态卡片上那行补充说明：重连到第几次、上次什么时候还好着。 */
export function statusDetail(tunnel: TunnelSnapshot | null): string {
  if (!tunnel) return "";
  const bits: string[] = [];
  if (tunnel.status === "RECONNECTING" && tunnel.reconnects > 0) {
    bits.push(`第 ${tunnel.reconnects} 次重连`);
  }
  // 「拿到过地址又掉」和「压根没拿到过地址」要分开说：前者是链路不稳，
  // 后者多半是上游分配慢/超时。混成一句「正在重连」，A 就没法判断该等还是该改走局域网。
  if (tunnel.urlCycles > 0 && tunnel.status !== "ONLINE") {
    bits.push(`已试过 ${tunnel.urlCycles} 轮地址（每轮都会作废上一条链接）`);
  }
  if (tunnel.lastClientExit && !tunnel.lastClientExit.sawUrl) {
    bits.push("上一次是隧道客户端没等到地址就退了");
  }
  if (tunnel.onlineSince && tunnel.status === "ONLINE") {
    bits.push(`自 ${clockText(tunnel.onlineSince)} 起`);
  }
  if (tunnel.checkedAt) {
    bits.push(
      `${tunnel.reachable ? "验证可访问" : `最近一次验证失败${tunnel.probeError ? `（${probeText(tunnel.probeError)}）` : ""}于 ${clockText(tunnel.checkedAt)}`}`,
    );
  }
  if (tunnel.linkInvalidatedAt) {
    bits.push(
      `${clockText(tunnel.linkInvalidatedAt)} 链接作废，已结束 ${tunnel.sessionsCleaned} 个会话`,
    );
  }
  return bits.join(" · ");
}

function clockText(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(
    d.getSeconds(),
  ).padStart(2, "0")}`;
}

/** 需要安装客户端时给的那条命令（后端已经把命令原文翻译成人话带过来了，这里只兜底）。 */
export function installHint(tunnel: TunnelSnapshot | null): string | null {
  if (!tunnel?.error || !tunnel.error.includes("prepare-cloudflared"))
    return null;
  return "npm run prepare-cloudflared";
}

/**
 * 四个按钮该不该亮。抽成纯函数是因为：这里已经错过两次 ——
 * 文案让人去点一个界面上是灰的/名字不一样的按钮，比不写文案更坑。
 * 特别地，「手里只有一条未验证地址」时「再验一次」必须能点：
 * 那正是 A 唯一能推进这件事的动作。
 */
export function actionStates(tunnel: TunnelSnapshot | null): {
  canStart: boolean;
  canStop: boolean;
  canSwap: boolean;
  canRecheck: boolean;
} {
  const state = tunnel?.status ?? "STOPPED";
  const busy = state === "STARTING" || state === "RECONNECTING";
  // 未验证的地址也算「手里有地址」：可以重验、可以换一条，但不能复制（看 copyDisabledReason）
  const hasAnyBase = !!tunnel?.publicBaseUrl || !!tunnel?.pendingBaseUrl;
  return {
    canStart: state === "STOPPED" || state === "UNAVAILABLE",
    canStop: state === "ONLINE" || busy,
    canSwap: hasAnyBase,
    canRecheck: hasAnyBase && !tunnel?.reachable,
  };
}

/**
 * 状态轮询失败时给 A 看的那句话。
 *
 * 403 和「网络不通」必须分开说：控制会话 Cookie 只在当前进程有效，服务重启、
 * 或 A 从浏览器历史/书签直接打开 http://127.0.0.1:8787 而不是走那条一次性引导
 * 链接时，页面壳照样能打开（它是免 Cookie 的），但每个数据接口都会 403。
 * 以前这两种都印成「读不到通道状态」，A 只能猜是不是公网坏了 —— 实际上公网好得很。
 */
export const SESSION_LOST_HINT =
  "本机控制会话已失效：这条页面是旧的登录态。回到启动窗口里那条一次性引导链接重新打开（它只能用一次；找不到就重新双击启动脚本，会给你一条新的）。";

export function statusFetchErrorText(err: unknown): string {
  // 不 import ApiError：这里只关心状态码，保持本模块无副作用、能在 node 里直接断言。
  const status = (err as { status?: unknown } | null)?.status;
  return status === 403 ? SESSION_LOST_HINT : "读不到通道状态";
}

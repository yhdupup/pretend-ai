import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import {
  CONTROL_COOKIE_NAME,
  isValidControlToken,
} from "../security/control-token.js";

// A 入口控制会话鉴权中间件（PRD §12.3 / 技术适配声明 §5）。
//
// 对本机专用端的每一个请求，逐一校验 Host + Origin + Cookie 三者：
// - Host：必须是 127.0.0.1 或 localhost（防 DNS rebinding，把外部域名指向本机 IP 后诱导浏览器发起请求）。
// - Origin（如存在）：必须同样是 127.0.0.1 或 localhost（防跨站请求伪造 CSRF——B 端页面或任意第三方页面
//   即便诱导用户点击，也无法以本机源的身份发起请求）。
// - Cookie：必须携带当前进程内存中持有的控制令牌对应的会话 Cookie（防未完成 bootstrap 兑换的请求直接调用控制接口）。
//
// 三项中任意一项不满足，统一返回同一种 403 响应，不区分具体是哪一项失败——
// 避免把"到底是 Host 错、Origin 错、还是没登录"这种信息暴露给探测者（呼应 whitelist.ts 对 B 端的同一思路）。
//
// bootstrap 兑换路径本身是例外：那一次请求就是用来"换" Cookie 的，此时自然还没有 Cookie，
// 所以只校验 Host/Origin，不校验 Cookie；由 bootstrap 路由自己校验令牌。

const BOOTSTRAP_PREFIX = "/api/local/bootstrap/";

// 阶段5：A 工作台的页面壳、静态资源与存活探针不需要 Cookie。
// 原因：浏览器地址栏打开 http://127.0.0.1:8787/ 是顶级导航 —— 不带 Origin，bootstrap 之前也没有 Cookie；
// 而 bootstrap 成功之后总得有人把工作台发出来，启动脚本也总得能问一句「你活着吗」。
// 这只免掉 Cookie 这一关，Host + Origin 校验一点都不免；页面壳里没有任何会话数据，
// 数据一律走 /api/local/*，那些路径仍然逐个请求要求 Cookie。
const COOKIE_FREE_EXACT = new Set([
  "/",
  "/index.html",
  "/favicon.ico",
  "/selftest",
  "/api/local/health",
]);
const COOKIE_FREE_PREFIXES = ["/assets/", "/bootstrap/", "/sessions/"];

function needsControlCookie(pathname: string): boolean {
  // bootstrap 兑换路径：Cookie 此时还不存在，由路由自己校验一次性令牌。
  if (pathname.startsWith(BOOTSTRAP_PREFIX)) return false;
  if (COOKIE_FREE_EXACT.has(pathname)) return false;
  return !COOKIE_FREE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

const ALLOWED_HOSTNAMES = new Set(["127.0.0.1", "localhost"]);

function extractHostname(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  // Host 头形如 "127.0.0.1:8787" 或 "localhost:8787"，也可能没有端口。
  const withoutPort = hostHeader.startsWith("[")
    ? (hostHeader.split("]")[0]?.slice(1) ?? "") // 兼容 IPv6 字面量（本项目未使用，保守处理）
    : (hostHeader.split(":")[0] ?? "");
  return withoutPort || null;
}

function isAllowedHostname(hostname: string | null): boolean {
  return hostname !== null && ALLOWED_HOSTNAMES.has(hostname);
}

// 顶级导航（地址栏、书签）的 Sec-Fetch-Site 是 none / same-origin；从别的站点跳过来才是 cross-site。
// 老浏览器可能不带这个头，缺失时不拒——真正的门槛是那个 256 bit、只能用一次、不可猜测的令牌。
function isTopLevelNavigation(secFetchSite: string | undefined): boolean {
  if (!secFetchSite) return true;
  return secFetchSite === "none" || secFetchSite === "same-origin";
}

/**
 * Origin 校验。缺 Origin 时原则上保守拒绝（fetch/XHR 一律会带），唯一开口是
 * GET /api/local/bootstrap/<token>：浏览器地址栏直接打开一个链接时不发 Origin，
 * 而「打开引导链接换 Cookie」正是技术适配声明 §5 承诺的用法（阶段5 启动器也走这条路）。
 * 这个开口只建立会话、不读取也不修改任何数据，且 Cookie 是 SameSite=Strict，
 * 跨站请求带不上它，被诱导点击也换不来任何读权限。
 */
function isAllowedOrigin(
  originHeader: string | undefined,
  method: string,
  pathname: string,
  secFetchSite: string | undefined,
): boolean {
  if (!originHeader) {
    if (method !== "GET") return false;
    // 免 Cookie 那批（引导兑换、存活探针、页面壳与静态资源）：本来就是给顶级导航与本机进程用的。
    if (!needsControlCookie(pathname)) return isTopLevelNavigation(secFetchSite);
    // ⚠️ 浏览器同源 GET **不发 Origin**（本机真实 Chrome 实测：只带
    // `sec-fetch-site: same-origin`）。原先这里一律拒，结果是双击启动的工作台
    // 页面能开、但每个数据接口（/api/local/status、/settings、/selftest/env）全 403
    // —— 界面上就是「读不到通道状态」。curl 与单测都手写了一个 Origin 头，所以谁也没发现。
    //
    // 改判据：同源 fetch 认 Sec-Fetch-Site。这个头浏览器不给页面改（forbidden header），
    // 跨站请求要么是 <img>/<script>/表单跳转（cross-site，拒），要么是带 Origin 的 fetch（走上面
    // 的 Origin 比对，拒）。顶级导航到数据接口（none）不在任何使用场景里，继续拒。
    // 完全不带头的只有本机进程与 Safari 12~14 这类老浏览器：那时真正的门槛还是那个
    // 256 bit、不落盘、HttpOnly + SameSite=Strict 的 Cookie，跟现在的设计一致。
    return secFetchSite === undefined || secFetchSite === "same-origin";
  }
  try {
    const url = new URL(originHeader);
    return ALLOWED_HOSTNAMES.has(url.hostname);
  } catch {
    return false;
  }
}

function reject(c: Context): Response {
  return c.json({ error: "FORBIDDEN" }, 403);
}

export async function localAuth(
  c: Context,
  next: Next,
): Promise<Response | void> {
  const hostname = extractHostname(c.req.header("host"));
  if (!isAllowedHostname(hostname)) {
    return reject(c);
  }

  const pathname = new URL(c.req.url).pathname;
  if (
    !isAllowedOrigin(
      c.req.header("origin"),
      c.req.method,
      pathname,
      c.req.header("sec-fetch-site"),
    )
  ) {
    return reject(c);
  }

  if (!needsControlCookie(pathname)) {
    // 页面壳 / 静态资源 / 存活探针：Host、Origin 已校验通过，不要求控制会话 Cookie。
    await next();
    return;
  }

  const cookieValue = getCookie(c, CONTROL_COOKIE_NAME);
  if (!isValidControlToken(cookieValue)) {
    return reject(c);
  }

  await next();
}

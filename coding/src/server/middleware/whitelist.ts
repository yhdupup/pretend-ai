import type { Context, Next } from "hono";

// B 入口（公网/局域网可达）白名单中间件（开发文档 §七）。
// 允许三类路径：
//   1. /api/public/*   —— B 页面自己的接口；
//   2. /s/<会话id>     —— 阶段3：B 聊天页面本体（隧道只能指向 B 端口，页面也得从这里发出去）；
//   3. /assets/*       —— 上面那个页面的构建产物（只允许 dist/assets 目录内的文件）。
// 其余一切路径（包括 /a、/admin、/api/local/*、/api/config/*、/.env、/data/*、/src/*、/package.json、
// /debug/* 等）返回与「路由不存在」完全一致的 404，不暴露路径是否存在、也不暴露具体拒绝原因。
//
// 不区分「路径被拦截」和「路径真的不存在」——两者响应体和状态码必须一致。
// /s/* 不破坏这个性质：不管会话 id 是真是假都返回同一份 index.html（状态码也相同），
// 所以公网探测者依然无法据此枚举哪些链接有效。

const ALLOWED_API = "/api/public";
const ALLOWED_PAGE_PREFIXES = ["/s/", "/assets/"];

function isAllowed(pathname: string): boolean {
  if (pathname === ALLOWED_API || pathname.startsWith(ALLOWED_API + "/"))
    return true;
  return ALLOWED_PAGE_PREFIXES.some((p) => pathname.startsWith(p));
}

export async function publicWhitelist(
  c: Context,
  next: Next,
): Promise<Response | void> {
  const pathname = new URL(c.req.url).pathname;
  if (isAllowed(pathname)) {
    await next();
    return;
  }
  return c.notFound();
}

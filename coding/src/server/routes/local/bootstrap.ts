import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import type { Context } from "hono";
import { setCookie } from "hono/cookie";
import {
  consumeBootstrap,
  CONTROL_COOKIE_NAME,
} from "../../security/control-token.js";
import { logger } from "../../logger.js";
import { config } from "../../config.js";

// A 入口一次性 bootstrap 兑换（PRD §12.3：POST /api/local/bootstrap/:token）。
//
// 同时提供 GET：阶段5 的启动器是把一次性地址交给浏览器做首次导航的（技术适配声明 §5：
// 「浏览器直接访问该 URL 即可把一次性令牌换成 HttpOnly Cookie」），而顶级 GET 导航不发 Origin。
// GET 只建立会话 Cookie，不读不写任何业务数据；页面内的脚本仍走 POST。
//
// 本接口只能被成功兑换一次：第二次用同一个令牌调用也会失败，因为 control-token 内部维护的是
// 「是否已消费」标记，而不是简单的字符串比较。
// 令牌本身绝不能出现在日志字段、响应体或返回的 HTML 里——下面的分支都不带 token 值。

const app = new Hono();

// 兑换成功后把人送去的地方。阶段5 起 A 工作台由本进程同源发出，
// 所以默认跳同源的 "/"；页面还没构建（开发期只跑 Vite）时才退回 A_FRONTEND_DEV_URL。
function workbenchUrl(): string {
  if (config.aWorkbenchUrl) return config.aWorkbenchUrl;
  const index = path.join(path.resolve(config.aFrontendDistPath), "index.html");
  if (fs.existsSync(index)) return "/";
  return config.aFrontendDevUrl;
}

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  // 页面只有一段自清理脚本，不需要任何外部资源；CSP 顺手收紧。
  "content-security-policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
};

function exchange(c: Context, token: string): boolean {
  const ok = consumeBootstrap(token);
  if (!ok) {
    logger.warn("bootstrap exchange rejected");
    return false;
  }
  setCookie(c, CONTROL_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "Strict",
    path: "/",
    // 本机场景下不强制 Secure（http://127.0.0.1 无 TLS），但用 Host/Origin 校验 + HttpOnly + SameSite=Strict
    // 三重限制降低风险；Cookie 有效期与进程生命周期一致，不设 maxAge/expires 即会话 Cookie，
    // 关闭浏览器或进程重启（令牌随之更换）后自然失效。
  });
  logger.info("bootstrap exchange succeeded");
  return true;
}

app.post("/:token", (c) => {
  const token = c.req.param("token");
  if (!exchange(c, token)) return c.json({ error: "INVALID_TOKEN" }, 403);
  return c.json({ ok: true });
});

// 浏览器地址栏 / 启动器导航：兑换成功后立刻把令牌从地址栏抹掉（PRD §「bootstrap 后立即清除 URL 中的一次性令牌」），
// 再跳回 A 工作台。这里用 127.0.0.1 而不是 localhost：控制会话 Cookie 绑的就是 127.0.0.1 这个 hostname。
app.get("/:token", (c) => {
  const token = c.req.param("token");
  const entry = workbenchUrl();
  if (!exchange(c, token)) {
    return c.html(
      `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>引导失败</title>` +
        `<p style="font:14px/1.6 system-ui">这个引导链接无效，或者已经被用过一次。</p>` +
        `<p style="font:14px/1.6 system-ui">重新启动程序会生成新的链接。</p></html>`,
      403,
      HTML_HEADERS,
    );
  }
  return c.html(
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>本机控制会话已建立</title>` +
      `<p style="font:14px/1.6 system-ui">本机控制会话已建立，正在打开 A 工作台…` +
      `<a href="${entry}">没有跳转就点这里</a></p>` +
      `<script>history.replaceState(null, "", "/");setTimeout(function () { location.replace(${JSON.stringify(entry)}); }, 400);</script>` +
      `</html>`,
    200,
    HTML_HEADERS,
  );
});

export default app;

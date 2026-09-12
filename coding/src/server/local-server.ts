import path from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { localAuth } from "./middleware/local-auth.js";
import localBootstrap from "./routes/local/bootstrap.js";
import localSessions from "./routes/local/sessions.js";
import localSettings from "./routes/local/settings.js";
import localHealth from "./routes/local/health.js";
import localSelftest, { renderSelftestPage } from "./routes/local/selftest.js";
import { createASite } from "./static/a-site.js";
import { registerLocalSystemRoutes } from "./routes/local/system.js";
import { isUsingEnvControlToken } from "./security/control-token.js";

// A 入口：本机专用控制端。只绑定 127.0.0.1，不得对局域网/公网暴露。
//
// localAuth 中间件挂在 "*" 上，对本入口下的所有路径（包括 bootstrap 自身、A 工作台页面）
// 统一校验 Host/Origin；bootstrap 兑换路径与「页面壳 + 静态资源 + 存活探针」被中间件特判为不校验 Cookie，
// 其余所有 /api/local/* 路由都要求携带有效的控制会话 Cookie。
//
// 阶段5 起这个入口还负责发 A 工作台本体（/ + /assets/* + 前端手写路由），
// 因为「双击启动」的场景里没有 Vite dev server，没有一个会发页面的端口，自动打开工作台就是空话。

export function createLocalApp(): Hono {
  const app = new Hono();
  app.use("*", localAuth);
  // 地址栏直接打开这一个链接就能换 Cookie（GET 形态，阶段3）；A 前端则用 POST 形态。
  // 两个形态同一条路径，日志里印给用户的就是这个地址，不存在「日志地址打不开」。
  app.route("/api/local/bootstrap", localBootstrap);
  app.route("/api/local/sessions", localSessions);
  app.route("/api/local/settings", localSettings);
  // 启动脚本的存活探针（免 Cookie，只回 5 个字段）。
  app.route("/api/local/health", localHealth);
  if (config.selftestPage) app.route("/api/local/selftest", localSelftest);
  // /status、/tunnel/*、/shutdown（PRD §17.1）：公网通道是 A 本机才有的能力
  registerLocalSystemRoutes(app);

  const site = createASite(config.aFrontendDistPath);
  if (!site.distExists()) {
    logger.warn(
      `A 工作台未构建：找不到 ${path.join(site.root, "index.html")}，跑 npm run build -w apps/a-frontend 后重启（开发期可用 Vite dev server）`,
    );
  }
  app.get("/", (c) => site.entry(c));
  // 前端手写路由的三个形态（/ 、/bootstrap/:token、/sessions/:id）都返回同一份 index.html，
  // 不因路径未知而给出不同响应 —— 和 B 端 /s/:id 的语义一致。
  app.get("/bootstrap/:token", (c) => site.entry(c));
  app.get("/sessions/:id", (c) => site.entry(c));
  app.get("/assets/*", (c) => site.asset(c));
  if (config.selftestPage) app.get("/selftest", (c) => renderSelftestPage(c));

  return app;
}

export function startLocalServer() {
  const app = createLocalApp();
  const server = serve(
    {
      fetch: app.fetch,
      port: config.localPort,
      hostname: config.localHost,
    },
    (info) => {
      logger.info("local server started", {
        path: `${config.localHost}:${info.port}`,
      });
      if (isUsingEnvControlToken()) {
        // 只报“正在用环境变量里的开发令牌”，绝不把令牌值写进日志（PRD §18.6）。
        logger.warn(
          `LOCAL_CONTROL_TOKEN_SECRET from env is in use: open http://127.0.0.1:${config.localPort}/api/local/bootstrap/<that token> once to unlock the A UI`,
        );
      }
    },
  );
  return server;
}

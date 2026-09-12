import path from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { publicWhitelist } from "./middleware/whitelist.js";
import publicSessions from "./routes/public/sessions.js";
import publicHealth from "./routes/public/health.js";
import { createBSite } from "./static/b-site.js";

// B 入口：局域网/隧道可达的公共端。挂载白名单中间件，未在白名单内的路径
// 必须返回与「路由不存在」完全一致的 404（开发文档 §七）。
//
// 阶段3 起这里还负责发 B 的网页本体（/s/:id + /assets/*），因为隧道只能指向这一个端口：
// 如果它只会返回 JSON，B 拿到的公网链接就打不开页面。页面与 API 同源，也不需要 CORS。

export function createPublicApp(): Hono {
  const app = new Hono();
  app.use("*", publicWhitelist);
  app.route("/api/public/sessions", publicSessions);
  app.route("/api/public", publicHealth);

  const site = createBSite(config.bFrontendDistPath);
  if (!site.distExists) {
    logger.warn(
      `B 页面未构建：找不到 ${path.join(site.root, "index.html")}，跑 npm run build -w apps/b-frontend 后重启`,
    );
  }
  // B 到底有没有点开过这条链接，是排查时第一个要分岔的问题：
  // 没点开 → 链接根本没递到 / 递到的不是这台机器；点开了 → 后面看会话接口。
  // 修前这一句也不记，A 只能猜。只有页面本体这一个入口记（assets 不记，否则刷新一次就一堆）。
  const openedLinks = new Set<string>();
  app.get("/s/:id", (c) => {
    const id = c.req.param("id") ?? "";
    const ref = id.slice(0, 8);
    if (ref && !openedLinks.has(ref)) {
      openedLinks.add(ref);
      if (openedLinks.size > 200) openedLinks.clear(); // 不无界长下去；清了只是重新记一次“到达”
      logger.info("link opened", { linkEvent: "opened", linkRef: ref });
    }
    return site.entry(c);
  });
  app.get("/assets/*", (c) => site.asset(c));

  return app;
}

export function startPublicServer() {
  const app = createPublicApp();
  const server = serve(
    {
      fetch: app.fetch,
      port: config.publicPort,
      hostname: config.publicHost,
    },
    (info) => {
      logger.info("public server started", {
        path: `${config.publicHost}:${info.port}`,
      });
    },
  );
  return server;
}

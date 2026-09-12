import { Hono } from "hono";

// 阶段3：B 公开入口健康检查。
//
// 两个用途：(1) 隧道建好后判断「公网地址是不是真的能打到 B 入口」——拿到域名 ≠ 能用，
// Cloudflare 边缘路由生效要几秒钟；(2) 给启动脚本/运维一个可等的端点。
//
// 只回答「活着」，不回答「有几个人在用」：不返回会话数、版本、路径、环境变量等任何可用信息。
// 它落在 /api/public/* 下，因此天然在白名单内；A 入口没有这个路径。
//
// ?probe=<随机串> 原样回显（PRD §13.3）：探活方每次带一个新随机值，回显对不上就说明
// 打到的是 CDN/中间缓存或别人的页面，而不是这个 B 入口 —— 只看 {ok:true} 会被缓存假阳性骗过。
// 回显本身不写日志：随机串没有含义，也没有可泄露的东西。

const app = new Hono();

app.get("/health", (c) => {
  const probe = c.req.query("probe");
  return c.json({
    ok: true,
    service: "b" as const,
    serverTime: new Date().toISOString(),
    // 只回显安全字符组成的短随机串，其它一律当没传（避免把任意外部内容写进响应）
    probe: probe && /^[A-Za-z0-9_-]{1,64}$/.test(probe) ? probe : null,
  });
});

export default app;

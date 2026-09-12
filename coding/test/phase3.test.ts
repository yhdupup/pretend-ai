import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../src/server/config";
import { createPublicApp } from "../src/server/public-server";
import { createLocalApp } from "../src/server/local-server";
import { getDb } from "../src/server/db/index";
import { SessionRepository } from "../src/server/session/repository";
import {
  getControlToken,
  CONTROL_COOKIE_NAME,
  __resetBootstrapConsumedForTests,
} from "../src/server/security/control-token";
import type { TunnelManagerLike, TunnelSnapshot } from "../src/shared/types";

// 阶段3：公网通道的 HTTP 层行为。
// 覆盖 PRD §26 阶段3 验收里能在本机验证的部分：
//   - B 页面由 B 端口自己发（隧道只有一个落点）；
//   - 白名单仍然拒掉一切非允许路径，且不允许的路径与不存在的路径响应一致；
//   - /api/public/health 只回答活着，不泄露任何信息；
//   - A 的状态/隧道控制接口只在本机，隧道起不来也只返回状态、不 500；
//   - 浏览器地址栏直接打开 bootstrap（无 Origin 的顶级 GET 导航）能拿到控制会话。

function snapshot(over: Partial<TunnelSnapshot> = {}): TunnelSnapshot {
  return {
    status: "ONLINE",
    provider: "cloudflared",
    publicBaseUrl: "https://example.trycloudflare.com",
    publicUrlSource: "tunnel",
    error: null,
    reconnects: 0,
    since: new Date().toISOString(),
    onlineSince: new Date().toISOString(),
    linkInvalidatedAt: null,
    sessionsCleaned: 0,
    ...over,
  };
}

function fakeManager(over: Partial<TunnelManagerLike> = {}): TunnelManagerLike {
  return {
    snapshot: () => snapshot(),
    start: async () => {},
    stop: async () => {},
    reconnect: async () => {},
    recheck: async () => {},
    dispose: () => {},
    ...over,
  };
}

const system = await import("../src/server/routes/local/system.js");

// 页面侧请求一定带 Origin（同源也是 Origin），本机鉴权中间件靠它挡跨站
const PAGE_ORIGIN = "http://127.0.0.1:5173";
// 用 app.fetch(Request) 打进程内应用时要自己写 Host：fetch 规范里它是禁止设置的头部，
// 不会从 URL 自动带出来，而本机鉴权恰恰要校验 Host（防 DNS rebinding）。
const LOCAL_HOST = "127.0.0.1:8787";

// control-token 暴露给浏览器的是 /bootstrap/<token>（导航地址），真正的接口挂在 /api/local 下。
// 令牌要在用例里现取，不要在模块顶层求值——那样会踩到模块初始化顺序。
const TOKEN = getControlToken();
const BOOTSTRAP_API = `/api/local/bootstrap/${TOKEN}`;

// 兑换是一次性的一等公民：每个要用它的用例先解锁，再去点那一下。
function unlockBootstrap(): void {
  __resetBootstrapConsumedForTests();
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("阶段3 · 公网入口", () => {
  it("健康检查只回答活着", async () => {
    const app = createPublicApp();
    const res = await app.fetch(
      new Request("http://127.0.0.1:8788/api/public/health"),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(typeof body.serverTime).toBe("string");
    // 不暴露会话数、版本、路径、环境变量
    expect(JSON.stringify(body)).not.toMatch(/session|version|path|env|token/i);
  });

  it("health 的 probe 随机串原样回显（探活靠它认出缓存页/别人的域名）", async () => {
    const app = createPublicApp();
    const echoed = await json(
      await app.fetch(
        new Request("http://127.0.0.1:8788/api/public/health?probe=abc123"),
      ),
    );
    expect(echoed.probe).toBe("abc123");
    // 没带就不编一个；不合法字符一律当没传，免得把外部内容原样写进响应
    const none = await json(
      await app.fetch(new Request("http://127.0.0.1:8788/api/public/health")),
    );
    expect(none.probe).toBeNull();
    const weird = await json(
      await app.fetch(
        new Request(
          "http://127.0.0.1:8788/api/public/health?probe=" +
            encodeURIComponent("<script>"),
        ),
      ),
    );
    expect(weird.probe).toBeNull();
  });

  it("B 页面与构建产物可访问，未知路径仍然统一 404", async () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), "aiwindow-b-"));
    fs.mkdirSync(path.join(dist, "assets"));
    fs.writeFileSync(
      path.join(dist, "index.html"),
      `<!doctype html><title>B</title>`,
    );
    fs.writeFileSync(path.join(dist, "assets", "index.js"), `console.log(1)`);
    const previous = config.bFrontendDistPath;
    config.bFrontendDistPath = dist;
    try {
      const app = createPublicApp();

      const known = await app.fetch(
        new Request(
          "http://127.0.0.1:8788/s/11111111-1111-4111-8111-111111111111",
        ),
      );
      const unknown = await app.fetch(
        new Request(
          "http://127.0.0.1:8788/s/deadbeef-dead-4ead-beef-deadbeefdead",
        ),
      );
      expect(known.status).toBe(200);
      // 会话 id 是真是假，页面响应必须一模一样（否则公网可以枚举有效链接）
      expect(await unknown.text()).toBe(await known.text());

      const asset = await app.fetch(
        new Request("http://127.0.0.1:8788/assets/index.js"),
      );
      expect(asset.status).toBe(200);
      expect(asset.headers.get("content-type")).toContain("javascript");

      for (const p of [
        "/",
        "/a",
        "/api/local/status",
        "/package.json",
        "/data/local.sqlite",
        "/src/server/config.ts",
      ]) {
        const blocked = await app.fetch(
          new Request(`http://127.0.0.1:8788${p}`),
        );
        expect(blocked.status).toBe(404);
        expect(await blocked.text()).toBe("404 Not Found");
      }

      const traversal = await app.fetch(
        new Request("http://127.0.0.1:8788/assets/%2e%2e/index.html"),
      );
      expect(traversal.status).toBe(404);
    } finally {
      config.bFrontendDistPath = previous;
      fs.rmSync(dist, { recursive: true, force: true });
    }
  });

  it("创建会话返回可复制的公网链接", async () => {
    const repo = new SessionRepository(getDb());
    repo.cleanupAll();
    const previous = config.publicBaseUrl;
    config.publicBaseUrl = "https://ai.example.com";
    try {
      const local = createLocalApp();
      unlockBootstrap();
      await local.fetch(
        new Request(`http://127.0.0.1:8787${BOOTSTRAP_API}`, {
          method: "POST",
          headers: { host: LOCAL_HOST, origin: PAGE_ORIGIN },
        }),
      );
      const created = await local.fetch(
        new Request("http://127.0.0.1:8787/api/local/sessions", {
          method: "POST",
          headers: {
            host: LOCAL_HOST,
            origin: PAGE_ORIGIN,
            "content-type": "application/json",
            cookie: `${CONTROL_COOKIE_NAME}=${TOKEN}`,
          },
          body: JSON.stringify({
            aiName: "小雷 AI",
            avatarId: "robot-01",
            openingMessage: "在吗",
            revealMessage: "假装成功",
          }),
        }),
      );
      expect(created.status).toBe(201);
      const body = await json(created);
      expect(body.publicUrlSource).toBe("config");
      expect(body.publicUrl).toBe(
        `https://ai.example.com${body.publicPath as string}`,
      );
      expect(String(body.publicUrl)).toMatch(/^https:\/\//);
    } finally {
      config.publicBaseUrl = previous;
      repo.cleanupAll();
    }
  });
});

describe("阶段3 · A 本机状态与隧道控制", () => {
  afterEach(() => system.__setTunnelManagerForTests(null));

  async function localWithCookie() {
    const local = createLocalApp();
    unlockBootstrap();
    const res = await local.fetch(
      new Request(`http://127.0.0.1:8787${BOOTSTRAP_API}`, {
        method: "POST",
        headers: { host: LOCAL_HOST, origin: PAGE_ORIGIN },
      }),
    );
    expect(res.status).toBe(200);
    return {
      local,
      headers: {
        host: LOCAL_HOST,
        cookie: `${CONTROL_COOKIE_NAME}=${TOKEN}`,
        origin: PAGE_ORIGIN,
      },
    };
  }

  it("GET /api/local/status 返回状态快照", async () => {
    const { local, headers } = await localWithCookie();
    system.__setTunnelManagerForTests(
      fakeManager({
        snapshot: () =>
          snapshot({ status: "RECONNECTING", error: "正在自动重连" }),
      }),
    );
    const res = await local.fetch(
      new Request("http://127.0.0.1:8787/api/local/status", {
        headers: { ...headers, host: LOCAL_HOST },
      }),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    const tunnel = body.tunnel as TunnelSnapshot;
    expect(tunnel.status).toBe("RECONNECTING");
    expect(tunnel.error).toBe("正在自动重连");
    expect(typeof body.serverTime).toBe("string");
    expect(body.sessions).toEqual({ live: 0 });
    // 公网侧没有这个接口
    const publicApp = createPublicApp();
    const blocked = await publicApp.fetch(
      new Request("http://127.0.0.1:8788/api/local/status"),
    );
    expect(blocked.status).toBe(404);
  });

  it("recheck：只重验一次，走的是同一个状态返回结构", async () => {
    const { local, headers } = await localWithCookie();
    let called = 0;
    system.__setTunnelManagerForTests(
      fakeManager({
        recheck: async () => {
          called += 1;
        },
        snapshot: () =>
          snapshot({
            reachable: true,
            publicBaseUrl: "https://x.trycloudflare.com",
          }),
      }),
    );
    const res = await local.fetch(
      new Request("http://127.0.0.1:8787/api/local/tunnel/recheck", {
        method: "POST",
        headers: { ...headers, host: LOCAL_HOST },
      }),
    );
    expect(res.status).toBe(200);
    expect(called).toBe(1);
    expect(
      ((await json(res)).status as { tunnel: TunnelSnapshot }).tunnel.reachable,
    ).toBe(true);
  });

  it("隧道启动失败也返回 200 + 中文原因，不给前端甩 500", async () => {
    const { local, headers } = await localWithCookie();
    system.__setTunnelManagerForTests(
      fakeManager({
        start: async () => {
          throw new Error("boom");
        },
        snapshot: () =>
          snapshot({
            status: "RECONNECTING",
            publicBaseUrl: null,
            error: "公网通道没能建立，正在自动重试",
          }),
      }),
    );
    const res = await local.fetch(
      new Request("http://127.0.0.1:8787/api/local/tunnel/start", {
        method: "POST",
        headers: { ...headers, host: LOCAL_HOST },
      }),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect((body.status as { tunnel: TunnelSnapshot }).tunnel.error).toContain(
      "正在自动重试",
    );
  });

  it("地址栏直接打开 bootstrap 能换到控制会话（无 Origin 的顶级导航）", async () => {
    const local = createLocalApp();
    unlockBootstrap();
    const res = await local.fetch(
      new Request(`http://127.0.0.1:8787${BOOTSTRAP_API}`, {
        method: "GET",
        headers: { host: LOCAL_HOST, "sec-fetch-site": "none" },
      }),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    // 令牌不能留在页面上，且要把用户带去 A 工作台
    expect(html).not.toContain(TOKEN);
    expect(html).toContain("history.replaceState");
    expect(res.headers.get("set-cookie")).toContain(CONTROL_COOKIE_NAME);

    // 同一个令牌再用一次：拒绝，且不建立会话
    const again = await local.fetch(
      new Request(`http://127.0.0.1:8787${BOOTSTRAP_API}`, {
        method: "GET",
        headers: { host: LOCAL_HOST, "sec-fetch-site": "none" },
      }),
    );
    expect(again.status).toBe(403);

    // 从别的站点跳过来（会被种上 cookie 的那种）：拒
    const pushed = await local.fetch(
      new Request(`http://127.0.0.1:8787${BOOTSTRAP_API}`, {
        method: "GET",
        headers: { host: LOCAL_HOST, "sec-fetch-site": "cross-site" },
      }),
    );
    expect(pushed.status).toBe(403);

    // 开口只给 bootstrap：其它本机接口没有 Origin 一样拒
    const noOrigin = await local.fetch(
      new Request("http://127.0.0.1:8787/api/local/sessions", {
        method: "POST",
        headers: { host: LOCAL_HOST },
      }),
    );
    expect(noOrigin.status).toBe(403);
  });
});

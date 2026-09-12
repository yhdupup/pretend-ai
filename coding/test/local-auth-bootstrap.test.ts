import { beforeEach, describe, expect, it } from "vitest";
import { createLocalApp } from "../src/server/local-server.js";
import {
  CONTROL_COOKIE_NAME,
  __resetBootstrapConsumedForTests,
  getControlToken,
} from "../src/server/security/control-token.js";

// 把已删除的临时脚本 scripts/tmp-verify-bootstrap.mjs 的 8 个手工验证场景
// 转成永久 Vitest 用例，覆盖 PRD §12.3 / 技术适配声明 §5 的 Host+Origin+Cookie 三重校验
// 以及 bootstrap 一次性兑换语义。

const LOCAL_ORIGIN = "http://127.0.0.1:8787";

function extractCookieValue(setCookieHeader: string | null): string | null {
  if (!setCookieHeader) return null;
  const match = setCookieHeader.match(
    new RegExp(`${CONTROL_COOKIE_NAME}=([^;]+)`),
  );
  return match?.[1] ?? null;
}

describe("local-auth + bootstrap exchange", () => {
  beforeEach(() => {
    __resetBootstrapConsumedForTests();
  });

  it("rejects a bad Host header with 403", async () => {
    const app = createLocalApp();
    const res = await app.request("/api/local/sessions", {
      headers: { host: "evil.example.com", origin: LOCAL_ORIGIN },
    });
    expect(res.status).toBe(403);
  });

  it("rejects a request with no cookie and no bootstrap with 403", async () => {
    const app = createLocalApp();
    const res = await app.request("/api/local/sessions", {
      headers: { host: "127.0.0.1:8787", origin: LOCAL_ORIGIN },
    });
    expect(res.status).toBe(403);
  });

  it("rejects an incorrect bootstrap token with 403", async () => {
    const app = createLocalApp();
    const res = await app.request("/api/local/bootstrap/not-the-real-token", {
      method: "POST",
      headers: { host: "127.0.0.1:8787", origin: LOCAL_ORIGIN },
    });
    expect(res.status).toBe(403);
  });

  it("accepts the correct bootstrap token exactly once, returning 200 + Set-Cookie", async () => {
    const app = createLocalApp();
    const token = getControlToken();
    const res = await app.request(`/api/local/bootstrap/${token}`, {
      method: "POST",
      headers: { host: "127.0.0.1:8787", origin: LOCAL_ORIGIN },
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).not.toBeNull();
    expect(extractCookieValue(setCookie)).toBe(token);
  });

  it("rejects replay of the same correct token with 403 (one-time enforcement)", async () => {
    const app = createLocalApp();
    const token = getControlToken();

    const first = await app.request(`/api/local/bootstrap/${token}`, {
      method: "POST",
      headers: { host: "127.0.0.1:8787", origin: LOCAL_ORIGIN },
    });
    expect(first.status).toBe(200);

    const second = await app.request(`/api/local/bootstrap/${token}`, {
      method: "POST",
      headers: { host: "127.0.0.1:8787", origin: LOCAL_ORIGIN },
    });
    expect(second.status).toBe(403);
  });

  it("allows a request with a valid cookie through to a protected route", async () => {
    const app = createLocalApp();
    const token = getControlToken();

    const exchange = await app.request(`/api/local/bootstrap/${token}`, {
      method: "POST",
      headers: { host: "127.0.0.1:8787", origin: LOCAL_ORIGIN },
    });
    const cookieValue = extractCookieValue(exchange.headers.get("set-cookie"));
    expect(cookieValue).not.toBeNull();

    const res = await app.request("/api/local/sessions", {
      method: "POST",
      headers: {
        host: "127.0.0.1:8787",
        origin: LOCAL_ORIGIN,
        cookie: `${CONTROL_COOKIE_NAME}=${cookieValue}`,
      },
    });
    // 只要通过了 localAuth 就应继续走到路由处理逻辑（不是 403）
    expect(res.status).not.toBe(403);
  });

  it("rejects a request with missing Origin with 403 (non-bootstrap path)", async () => {
    const app = createLocalApp();
    const res = await app.request("/api/local/sessions", {
      headers: { host: "127.0.0.1:8787" },
    });
    expect(res.status).toBe(403);
  });

  it("rejects a cross-origin Origin with 403", async () => {
    const app = createLocalApp();
    const res = await app.request("/api/local/sessions", {
      headers: { host: "127.0.0.1:8787", origin: "http://evil.example.com" },
    });
    expect(res.status).toBe(403);
  });
  it("also allows localhost as an equivalent Host/Origin", async () => {
    const app = createLocalApp();
    const token = getControlToken();
    const res = await app.request(`/api/local/bootstrap/${token}`, {
      method: "POST",
      headers: { host: "localhost:8787", origin: "http://localhost:8787" },
    });
    expect(res.status).toBe(200);
  });

  // 以下这组用的是 2026-09-11 用真实 Chrome（Playwright，已排除本机代理干扰）现场抓到的请求头。
  // 写这一组的理由：上一组全部手写了 origin，于是「浏览器同源 GET 根本不带 Origin」
  // 这个事实没被任何用例碰到，导致双击启动的工作台页面能开、但每个数据接口 403。
  // 记住：测鉴权要按浏览器真实会发的头测，不能按我们希望它发的头测。
  async function unlockCookie(app: ReturnType<typeof createLocalApp>) {
    __resetBootstrapConsumedForTests();
    const token = getControlToken();
    const boot = await app.request(`/api/local/bootstrap/${token}`, {
      // 地址栏导航：不带 Origin，Sec-Fetch-Site 是 none。
      headers: { host: "127.0.0.1:8787", "sec-fetch-site": "none" },
    });
    expect(boot.status).toBe(200);
    return extractCookieValue(boot.headers.get("set-cookie"));
  }

  const REAL_BROWSER_GET = (cookie: string | null) => ({
    host: "127.0.0.1:8787",
    cookie: `${CONTROL_COOKIE_NAME}=${cookie}`,
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    // 注意：没有 origin —— 真实浏览器的同源 fetch 就是这样。
  });

  it("real-browser same-origin GET（无 Origin + Sec-Fetch-Site: same-origin）带 Cookie 能读到数据", async () => {
    const app = createLocalApp();
    const cookie = await unlockCookie(app);
    const res = await app.request("/api/local/status", {
      headers: REAL_BROWSER_GET(cookie),
    });
    expect(res.status).toBe(200);
  });

  it("跨站 GET（无 Origin + Sec-Fetch-Site: cross-site）即使带着 Cookie 也拒", async () => {
    const app = createLocalApp();
    const cookie = await unlockCookie(app);
    for (const site of ["cross-site", "cross-origin"]) {
      const res = await app.request("/api/local/status", {
        headers: { ...REAL_BROWSER_GET(cookie), "sec-fetch-site": site },
      });
      expect(res.status).toBe(403);
    }
  });

  it("顶级导航到数据接口（Sec-Fetch-Site: none）仍拒：没有这种使用场景，不给它开口子", async () => {
    const app = createLocalApp();
    const cookie = await unlockCookie(app);
    const res = await app.request("/api/local/status", {
      headers: { ...REAL_BROWSER_GET(cookie), "sec-fetch-site": "none" },
    });
    expect(res.status).toBe(403);
  });

  it("同源但写操作（POST 无 Origin）仍拒 —— 放宽只针对 GET， CSRF 门槛不动", async () => {
    const app = createLocalApp();
    const cookie = await unlockCookie(app);
    const res = await app.request("/api/local/sessions", {
      method: "POST",
      headers: { ...REAL_BROWSER_GET(cookie), "sec-fetch-mode": "cors" },
    });
    expect(res.status).toBe(403);
  });

  it("两个头都没有（老 Safari / 本机进程）：放行判定退回到 Cookie 本身", async () => {
    // 这是同源放宽留下的唯一开口：Sec-Fetch-Site 缺失时不能假定它是跨站（Safari 12~14 不带），
    // 于是这条请求的门槛就只剩那个 HttpOnly + SameSite=Strict 的 Cookie。
    // 钉住它的目的不是夸它安全，而是让「哪天要收紧」这件事在测试里看得见。
    const app = createLocalApp();
    const cookie = await unlockCookie(app);
    const bare = await app.request("/api/local/status", {
      headers: { host: "127.0.0.1:8787", cookie: `${CONTROL_COOKIE_NAME}=${cookie}` },
    });
    expect(bare.status).toBe(200);
    // 但没有 Cookie 时同一个形状必须还是 403：开口只给持有令牌的人，不给任何本机进程
    const noCookie = await app.request("/api/local/status", {
      headers: { host: "127.0.0.1:8787" },
    });
    expect(noCookie.status).toBe(403);
  });

  it("免 Cookie 路径不受影响：无 Origin 无 Sec-Fetch-Site 的存活探针仍可过（启动脚本靠它）", async () => {
    const app = createLocalApp();
    const res = await app.request("/api/local/health?probe=script1", {
      headers: { host: "127.0.0.1:8787" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "a", probe: "script1" });
  });
});

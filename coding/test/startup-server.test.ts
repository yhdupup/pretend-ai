import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 阶段5 档1：A 入口同源发页面（§5.8）+ 存活探针（§5.6）+ 令牌交接（§5.7）的服务端侧。
//
// 这一档全部走 app.fetch(Request)，不起真端口：
// 要验的是路由与鉴权形状，真端口的行为在档2/档3 里看。

const { createLocalApp } = await import("../src/server/local-server.js");
const { createPublicApp } = await import("../src/server/public-server.js");
const { config } = await import("../src/server/config.js");
const {
  getControlToken,
  CONTROL_COOKIE_NAME,
  isUsingEnvControlToken,
  __resetBootstrapConsumedForTests,
} = await import("../src/server/security/control-token.js");

const PAGE_ORIGIN = "http://127.0.0.1:8787";
const LOCAL_HOST = "127.0.0.1:8787";

// A 前端产物的临时替身：测试不能依赖真 dist 里有什么文件，
// 但必须能造出「assets 里有一个已知名字的 js」和「index.html 是这一份」两种确定状态。
function makeDist(dir: string, { assets = true } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "index.html"),
    `<!doctype html><html lang="zh-CN"><title>A 工作台</title><body><div id="root"></div></body></html>`,
  );
  if (assets) {
    fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "assets", "index-abc123.js"),
      `console.log("workbench");`,
    );
    fs.writeFileSync(path.join(dir, "assets", "leak.env"), "USER_MODEL_API_KEY=假的");
  }
  return dir;
}

const tempDirs: string[] = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiwindow-asite-"));
  tempDirs.push(dir);
  return dir;
}

const originalDist = config.aFrontendDistPath;

function useDist(dir: string) {
  config.aFrontendDistPath = dir;
}

afterEach(() => {
  useDist(originalDist);
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 进程内打 app.fetch 时必须自己写 Host：fetch 规范禁止设置它，不会从 URL 自动带出来，
// 而本机鉴权恰恰要校验 Host（防 DNS rebinding）。不带 Origin 是刻意的 ——
// 地址栏导航与脚本探活都没有 Origin，这条路径的开口规则正是被测对象。
function local(pathname: string, init: RequestInit = {}) {
  const { host, ...restInit } = init as RequestInit & { host?: string };
  return createLocalApp().fetch(
    new Request(`http://${host ?? LOCAL_HOST}${pathname}`, {
      ...restInit,
      headers: { host: host ?? LOCAL_HOST, ...(restInit.headers ?? {}) },
    }),
  );
}

// 解锁控制会话后再请求：用来区分「被鉴权挡住」与「路由不存在」
async function localWithCookie(pathname: string) {
  __resetBootstrapConsumedForTests();
  const token = getControlToken();
  const bootstrap = await local(`/api/local/bootstrap/${token}`);
  expect(bootstrap.status).toBe(200);
  const raw = bootstrap.headers.get("set-cookie") ?? "";
  const value = raw.split(";")[0];
  expect(value).toContain(CONTROL_COOKIE_NAME);
  return local(pathname, { headers: { cookie: value, origin: PAGE_ORIGIN } });
}

describe("A 工作台由本机入口自己发（§5.8）", () => {
  beforeEach(() => {
    useDist(makeDist(tempDir()));
    __resetBootstrapConsumedForTests();
  });

  it("GET / 不需要 Cookie 就能拿到页面壳，并且不缓存", async () => {
    const res = await local("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await res.text()).toContain("A 工作台");
  });

  it("前端手写路由（/bootstrap/:token、/sessions/:id）返回同一份壳，不给不同响应形态", async () => {
    const entry = await (await local("/")).text();
    expect(await (await local("/sessions/abc")).text()).toBe(entry);
    // 这条是前端路由，不是 /api/local/bootstrap 那个兑换接口；两者形状必须不同
    expect(await (await local("/bootstrap/whatever")).text()).toBe(entry);
  });

  it("/assets/* 命中构建产物时长缓存，扩展名不在白名单里一律 404", async () => {
    const hit = await local("/assets/index-abc123.js");
    expect(hit.status).toBe(200);
    expect(hit.headers.get("content-type")).toContain("text/javascript");
    expect(hit.headers.get("cache-control")).toContain("immutable");
    expect(hit.headers.get("cache-control")).toContain("max-age=31536000");

    // 扩展名不在 MIME 白名单里：宁可 404 也不猜类型（猜错=把任意文件当文本发出去）
    const unknown = await local("/assets/leak.env");
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).not.toContain("USER_MODEL_API_KEY");
    expect((await local("/assets/nope.js")).status).toBe(404);
  });

  it("路径穿越拿不到 dist 之外的东西", async () => {
    // 这一组既测 a-site 的 safeJoin，也测「穿越到别的目录后扩展名不在白名单里」这一层。
    // 状态码可能是 404（走到静态层被拒）也可能是 403（URL 被规范化成需要会话的路径），
    // 两种都算安全；出现 200 或内容泄露才算失败。
    const attempts = [
      "/assets/%2e%2e/package.json",
      "/assets/%2e%2e/%2e%2e/.env.local",
      "/assets/..%2F..%2Fcoding%2Fpackage.json",
      "/assets/%2e%2e/secrets.sqlite",
      "/assets/%00/index.html",
      `/assets/${encodeURIComponent("..\\" + "..\\" + "coding\\package.json")}`,
    ];
    for (const attempt of attempts) {
      const res = await local(attempt);
      expect(res.status, attempt).not.toBe(200);
      const text = await res.text();
      expect(text, attempt).not.toContain("better-sqlite3");
      expect(text, attempt).not.toContain("USER_MODEL_API_KEY");
    }
  });

  it("safeJoin 直接拒掉越界路径（不依赖 URL 规范化帮它擦屁股）", async () => {
    const { Hono } = await import("hono");
    const { createASite } = await import("../src/server/static/a-site.js");
    const dist = makeDist(tempDir());
    const site = createASite(dist);
    const bare = new Hono();
    // 不挂 local-auth：这里要问的是「静态层自己能不能挡住」，而不是鉴权层帮它挡。
    bare.get("/assets/*", (c) => site.asset(c));
    for (const attempt of [
      "/assets/%2e%2e/package.json",
      "/assets/%2e%2e/%2e%2e/runtime-manifest.json",
      "/assets/./%2e%2e/apps/a-frontend/index.html",
    ]) {
      const res = await bare.fetch(
        new Request(`http://${LOCAL_HOST}${attempt}`, {
          headers: { host: LOCAL_HOST },
        }),
      );
      expect(res.status, attempt).toBe(404);
      expect(await res.text(), attempt).not.toContain("better-sqlite3");
    }
    // 同一个 dist 里的正常文件仍然发得出去（证明 404 不是因为整个路由坏了）
    expect((await bare.fetch(
      new Request(`http://${LOCAL_HOST}/assets/index-abc123.js`, {
        headers: { host: LOCAL_HOST },
      }),
    )).status).toBe(200);
  });

  it("两条允许路径之外的路径 404，不回落成 index（那会把 API 拼错伪装成成功页）", async () => {
    for (const pathname of ["/about", "/api/local", "/assets", "/index.html.real"]) {
      // 没换到会话 Cookie 之前，这些路径先被鉴权拦下：403 而不是 404（不给探测者区分线索）
      expect((await local(pathname)).status, pathname).toBe(403);
      // 解锁会话之后才是 404：证明它没有偷偷回落成工作台壳
      expect((await localWithCookie(pathname)).status, pathname).toBe(404);
    }
  });

  it("产物没构建时给 503 中文提示页，而不是空白 200", async () => {
    useDist(path.join(tempDir(), "not-built-yet")); // dist 目录压根不存在
    const res = await local("/");
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(text).toContain("还没有构建");
    // 提示里给的是相对路径与命令，不能把本机绝对路径写进响应（PRD §18.6）
    expect(text).not.toContain(os.tmpdir());
  });

  it("页面壳本身不含任何会话数据：没有 Cookie 也读不到 sessions", async () => {
    const res = await local("/sessions/deadbeef");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toMatch(/deadbeef|messages|api_key|token/);
  });
});

describe("A 侧存活探针 /api/local/health（§5.6）", () => {
  beforeEach(() => {
    useDist(makeDist(tempDir()));
  });

  it("无 Cookie、无 Origin（脚本就是这么问的）→ 200", async () => {
    const res = await local("/api/local/health?probe=deadbeef1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "a", probe: "deadbeef1" });
  });

  it("响应只有三个字段，不含版本/路径/会话/端口", async () => {
    const body = (await (
      await local("/api/local/health?probe=x1")
    ).json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["ok", "probe", "service"]);
    expect(JSON.stringify(body)).not.toMatch(/version|path|env|token|session|port/i);
  });

  it("随机串对不上就不是本项目：只认白名单字符，其它一律 null", async () => {
    const none = (await (await local("/api/local/health")).json()) as {
      probe: string | null;
    };
    expect(none.probe).toBeNull();
    const weird = (await (
      await local(`/api/local/health?probe=${encodeURIComponent("<script>")}`)
    ).json()) as { probe: string | null };
    expect(weird.probe).toBeNull();
    const long = (await (
      await local(`/api/local/health?probe=${"a".repeat(65)}`)
    ).json()) as { probe: string | null };
    expect(long.probe).toBeNull();
  });

  it("本机网页跨源读不到它（只免 Cookie，不免来源校验）", async () => {
    const res = await local("/api/local/health", {
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
    const viaHost = await createLocalApp().fetch(
      new Request("http://evil.example:8787/api/local/health", {
        headers: { host: "evil.example:8787" },
      }),
    );
    expect(viaHost.status).toBe(403);
  });

  it("B 入口没有这条路由（公网永远问不到 A 的探针）", async () => {
    const app = createPublicApp();
    const res = await app.fetch(
      new Request("http://127.0.0.1:8788/api/local/health?probe=abc"),
    );
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain('"service":"a"');
  });

  it("A 入口不回答 B 的探针路径（两个入口的职责不互相顶）", async () => {
    // 无 Cookie 时统一 403（鉴权先于路由），有 Cookie 时 404（这条路由压根没挂）
    expect((await local("/api/public/health?probe=abc")).status).toBe(403);
    const authed = await localWithCookie("/api/public/health?probe=abc");
    expect(authed.status).toBe(404);
    expect(await authed.text()).not.toContain('"service"');
  });
});

describe("启动器令牌交接（§5.7）", () => {
  const saved = {
    nodeEnv: process.env.NODE_ENV,
    secret: process.env.LOCAL_CONTROL_TOKEN_SECRET,
    launcher: process.env.AIWINDOW_LAUNCHER_TOKEN,
  };

  afterEach(() => {
    process.env.NODE_ENV = saved.nodeEnv;
    if (saved.secret === undefined) delete process.env.LOCAL_CONTROL_TOKEN_SECRET;
    else process.env.LOCAL_CONTROL_TOKEN_SECRET = saved.secret;
    if (saved.launcher === undefined) delete process.env.AIWINDOW_LAUNCHER_TOKEN;
    else process.env.AIWINDOW_LAUNCHER_TOKEN = saved.launcher;
    vi.resetModules();
  });

  it("生产模式下由启动器经 shell 注入 → 生效（这是脚本能自动打开工作台的前提）", async () => {
    vi.resetModules();
    const token = "a".repeat(64);
    process.env.NODE_ENV = "production";
    process.env.LOCAL_CONTROL_TOKEN_SECRET = token;
    process.env.AIWINDOW_LAUNCHER_TOKEN = "1";
    // 上面三个键是在 config 模块求值之前设进去的，等价于「shell 导出的」
    const mod = await import("../src/server/security/control-token.js");
    expect(mod.getControlToken()).toBe(token);
    expect(mod.isUsingEnvControlToken()).toBe(true);
  });

  it("生产模式下往 .env 文件里手写令牌 → 不生效（PRD §12.3 每次启动随机）", async () => {
    vi.resetModules();
    process.env.NODE_ENV = "production";
    delete process.env.LOCAL_CONTROL_TOKEN_SECRET;
    delete process.env.AIWINDOW_LAUNCHER_TOKEN;
    const cfg = await import("../src/server/config.js");
    const mod = await import("../src/server/security/control-token.js");
    // 模拟 dotenv 阶段4注入：config 已经求值完，键才出现 —— 这就不是 shell 导出的
    const written = "b".repeat(64);
    process.env.LOCAL_CONTROL_TOKEN_SECRET = written;
    process.env.AIWINDOW_LAUNCHER_TOKEN = "1";
    expect(cfg.fromShellEnv("LOCAL_CONTROL_TOKEN_SECRET")).toBe(false);
    expect(mod.isUsingEnvControlToken()).toBe(false);
    expect(mod.getControlToken()).not.toBe(written);
    expect(mod.getControlToken()).toHaveLength(64); // 自己生成的 256 bit hex
  });

  it("只有 AIWINDOW_LAUNCHER_TOKEN=1 但没有令牌 → 用随机值，不崩", async () => {
    vi.resetModules();
    process.env.NODE_ENV = "production";
    delete process.env.LOCAL_CONTROL_TOKEN_SECRET;
    process.env.AIWINDOW_LAUNCHER_TOKEN = "1";
    await import("../src/server/config.js");
    const mod = await import("../src/server/security/control-token.js");
    expect(mod.isUsingEnvControlToken()).toBe(false);
    expect(mod.getControlToken()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("令牌太短（<16）当没填，避免手滑把一个弱值当控制令牌", async () => {
    vi.resetModules();
    process.env.NODE_ENV = "production";
    process.env.LOCAL_CONTROL_TOKEN_SECRET = "short";
    process.env.AIWINDOW_LAUNCHER_TOKEN = "1";
    const mod = await import("../src/server/security/control-token.js");
    expect(mod.getControlToken()).not.toBe("short");
    expect(mod.isUsingEnvControlToken()).toBe(false);
  });

  it("一次性兑换：同一个令牌换过一次之后再换就失败", async () => {
    vi.resetModules();
    const mod = await import("../src/server/security/control-token.js");
    mod.__resetBootstrapConsumedForTests();
    const token = mod.getControlToken();
    expect(mod.consumeBootstrap(token)).toBe(true);
    expect(mod.consumeBootstrap(token)).toBe(false);
    // Cookie 仍然有效（兑换成功之后靠的是 Cookie，不是再来一次 bootstrap）
    expect(mod.isValidControlToken(token)).toBe(true);
    expect(mod.isValidControlToken(`${token}x`)).toBe(false);
  });

  it("GET /api/local/bootstrap/<token> 建立 Cookie 并把令牌从地址栏抹掉", async () => {
    useDist(makeDist(tempDir()));
    __resetBootstrapConsumedForTests();
    const token = getControlToken();
    const res = await local(`/api/local/bootstrap/${token}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(CONTROL_COOKIE_NAME);
    expect(cookie).toContain("HttpOnly");
    expect(cookie.toLowerCase()).toContain("samesite=strict");
    // 会话 Cookie：不写 expires/max-age，进程一换令牌就跟着作废
    expect(cookie).not.toMatch(/max-age|expires/i);
    // 引导页里不能出现令牌字符串本身（它已经在 URL 里了，别再抄一份进 body/history）
    expect(await res.text()).not.toContain(token);
    expect(CONTROL_COOKIE_NAME).toBeTruthy();
    expect(isUsingEnvControlToken).toBeTypeOf("function");
  });

  it("引导链接用过一次之后，第二次导航失败但不泄露原因细节", async () => {
    useDist(makeDist(tempDir()));
    __resetBootstrapConsumedForTests();
    const token = getControlToken();
    expect((await local(`/api/local/bootstrap/${token}`)).status).toBe(200);
    const again = await local(`/api/local/bootstrap/${token}`);
    expect(again.status).toBe(403);
    const text = await again.text();
    expect(text).toContain("已经被用过");
    expect(text).not.toContain(token);
  });
});

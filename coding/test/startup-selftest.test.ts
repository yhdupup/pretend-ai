import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 阶段5 档1：自检台（/selftest + /api/local/selftest/*）。
//
// 这一页是「给 A 自己判这台机器准备好没有」的界面，本身却一直没被任何用例覆盖 ——
// 结果就是它悄悄落后于实现：健康探针早就去掉了 port 字段、未知路径的 403/404 语义也变了，
// 页面里的断言还在按老规矩写。补上这一组，是为了让「页面说的」和「服务做的」不能再各说各话。

const { createLocalApp } = await import("../src/server/local-server.js");
const { createPublicApp } = await import("../src/server/public-server.js");
const { config } = await import("../src/server/config.js");
const {
  getControlToken,
  CONTROL_COOKIE_NAME,
  __resetBootstrapConsumedForTests,
} = await import("../src/server/security/control-token.js");

const LOCAL_HOST = "127.0.0.1:8787";
// 真实浏览器同源 GET 就是这一组头：没有 origin，只有 sec-fetch-site。
const BROWSER_SAME_ORIGIN = { host: LOCAL_HOST, "sec-fetch-site": "same-origin" };

const tempDirs: string[] = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiwindow-selftest-"));
  tempDirs.push(dir);
  return dir;
}

const original = {
  projectRoot: config.projectRoot,
  selftestHtmlPath: config.selftestHtmlPath,
  selftestPage: config.selftestPage,
  publicPort: config.publicPort,
};

afterEach(() => {
  config.publicPort = original.publicPort;
  config.projectRoot = original.projectRoot;
  config.selftestHtmlPath = original.selftestHtmlPath;
  config.selftestPage = original.selftestPage;
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** 造一个「启动脚本刚跑完一轮」的项目壳子，让 launcher 事实有确定的东西可读。 */
function makeProject(opts: { logWithToken?: boolean } = {}) {
  const root = tempDir();
  const runtime = path.join(root, ".runtime");
  const logs = path.join(root, "logs");
  fs.mkdirSync(path.join(runtime, "node", "v24.18.1"), { recursive: true });
  fs.mkdirSync(path.join(root, "coding", "bin"), { recursive: true });
  fs.mkdirSync(logs, { recursive: true });

  // 真实写入方（scripts/start.mjs）写的是一整个 JSON，不是裸数字 ——
  // 夹具必须照真实形状造，否则「解析对了」这件事根本测不到（第一版就是这么错的）。
  fs.writeFileSync(
    path.join(runtime, "server.pid"),
    JSON.stringify({
      pid: process.pid,
      nodeExe: path.join(runtime, "node", "v24.18.1", "bin", "node"),
      startedAt: Date.now(),
      ports: { local: config.localPort, public: config.publicPort },
      entry: path.join(root, "coding", "dist", "server", "index.js"),
    }),
  );
  fs.writeFileSync(path.join(runtime, "start.lock"), "1\n");
  fs.writeFileSync(
    path.join(runtime, "deps.stamp.json"),
    JSON.stringify({
      depsKey: "a".repeat(64),
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      writtenAt: "2026-09-11T15:08:53.268Z",
    }),
  );
  fs.writeFileSync(
    path.join(runtime, "build.stamp.json"),
    JSON.stringify({ sourceKey: "b".repeat(64), writtenAt: "2026-09-11T16:36:33.597Z" }),
  );
  fs.writeFileSync(
    path.join(root, "runtime-manifest.json"),
    JSON.stringify({ node: { version: "v24.18.1" }, cloudflared: { version: "2025.4.2" } }),
  );
  fs.writeFileSync(
    path.join(root, "coding", "bin", "cloudflared-receipt.json"),
    JSON.stringify({
      tool: "cloudflared",
      version: "2025.4.2",
      target: "cloudflared-darwin-arm64",
      sha256: "c".repeat(64),
      source: "github-release",
      checksPassed: ["macos-codesign:Cloudflare", "sha256:pinned:cccccccccccc"],
    }),
  );
  fs.writeFileSync(path.join(logs, "run-2026-09-11T16-00-00-000Z.log"), '{"level":30,"msg":"ready"}\n');
  if (opts.logWithToken) {
    // 故意放一个 64 位十六进制进去：这条检查必须能真的抓到，不能永远返回 0 装作很忙。
    fs.writeFileSync(
      path.join(logs, "run-2026-09-11T16-30-00-000Z.log"),
      `{"level":30,"msg":"bootstrap","token":"${"d".repeat(64)}"}\n`,
    );
  }
  const html = path.join(root, "static", "selftest.html");
  fs.mkdirSync(path.dirname(html), { recursive: true });
  fs.writeFileSync(html, `<!doctype html><title>自检台</title><h1>自检台</h1>`);

  config.projectRoot = root;
  config.selftestHtmlPath = html;
  config.selftestPage = true;
  return root;
}

async function unlock(app: ReturnType<typeof createLocalApp>) {
  __resetBootstrapConsumedForTests();
  const boot = await app.request(`/api/local/bootstrap/${getControlToken()}`, {
    headers: { host: LOCAL_HOST, "sec-fetch-site": "none" },
  });
  expect(boot.status).toBe(200);
  return (boot.headers.get("set-cookie") ?? "").match(
    new RegExp(`${CONTROL_COOKIE_NAME}=([^;]+)`),
  )?.[1];
}

describe("自检台页面本身", () => {
  it("免 Cookie 能打开（否则 A 没法用第一屏判状态）", async () => {
    makeProject();
    const app = createLocalApp();
    const res = await app.request("/selftest", { headers: BROWSER_SAME_ORIGIN });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("自检台");
  });

  it("但 Host 与 Origin 校验一点都不免：坏 Host、坏 Origin 都进不来", async () => {
    makeProject();
    const app = createLocalApp();
    expect(
      (await app.request("/selftest", { headers: { host: "evil.example:8787" } })).status,
    ).toBe(403);
    expect(
      (
        await app.request("/selftest", {
          headers: { host: LOCAL_HOST, origin: "http://evil.example" },
        })
      ).status,
    ).toBe(403);
    // 跨站脚本想把它当 iframe 塞进来：浏览器会打 cross-site，拒。
    expect(
      (
        await app.request("/selftest", {
          headers: { host: LOCAL_HOST, "sec-fetch-site": "cross-site" },
        })
      ).status,
    ).toBe(403);
  });

  it("不缓存、不嗅探、不引任何外部资源（离线也要能用）", async () => {
    makeProject();
    const app = createLocalApp();
    const res = await app.request("/selftest", { headers: BROWSER_SAME_ORIGIN });
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("connect-src 'self'");

    // 真页面本体：任何 src/href 指向 http(s) 外部域，或引了第三方脚本，都算破边界。
    const real = fs.readFileSync(
      path.join(process.cwd(), "static", "selftest.html"),
      "utf8",
    );
    expect(real).not.toMatch(/src=["']https?:/i);
    expect(real).not.toMatch(/href=["']https?:/i);
    expect(real).not.toMatch(/<script[^>]+src=/i);
  });

  it("开关关掉后这条路由根本不存在（不给自己留后门）", async () => {
    makeProject();
    config.selftestPage = false;
    const app = createLocalApp();
    expect(
      (await app.request("/selftest", { headers: BROWSER_SAME_ORIGIN })).status,
    ).not.toBe(200);
  });

  it("公网入口没有自检台：B 侧一个字节都读不到", async () => {
    makeProject();
    const pub = createPublicApp();
    for (const p of ["/selftest", "/api/local/selftest/env", "/api/local/health"]) {
      const res = await pub.request(p, { headers: { host: "127.0.0.1:8788" } });
      expect(res.status).toBe(404);
    }
  });
});

describe("自检数据接口", () => {
  it("要控制会话 Cookie：无 Cookie 的同源 GET 也一样拒", async () => {
    makeProject();
    const app = createLocalApp();
    const res = await app.request("/api/local/selftest/env", {
      headers: BROWSER_SAME_ORIGIN,
    });
    expect(res.status).toBe(403);
  });

  it("响应里没有任何令牌、密钥、或 64 位十六进制", async () => {
    makeProject();
    const app = createLocalApp();
    const cookie = await unlock(app);
    const res = await app.request("/api/local/selftest/env", {
      headers: { ...BROWSER_SAME_ORIGIN, cookie: `${CONTROL_COOKIE_NAME}=${cookie}` },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(getControlToken());
    expect(text).not.toMatch(/\b[0-9a-f]{64}\b/);
    for (const banned of ["USER_MODEL_API_KEY", "LOCAL_CONTROL_TOKEN_SECRET", "sk-"]) {
      expect(text).not.toContain(banned);
    }
  });

  it("把启动层的事实报清楚：pid 指向谁、stamp 还匹配不匹配、隧道件是哪来的", async () => {
    makeProject();
    const app = createLocalApp();
    const cookie = await unlock(app);
    const j: any = await (
      await app.request("/api/local/selftest/env", {
        headers: { ...BROWSER_SAME_ORIGIN, cookie: `${CONTROL_COOKIE_NAME}=${cookie}` },
      })
    ).json();

    expect(j.launcher.pidFile.exists).toBe(true);
    expect(j.launcher.pidFile.pointsAtThisProcess).toBe(true);
    expect(j.launcher.pidFile.processAlive).toBe(true);
    expect(j.launcher.lockFileExists).toBe(true);
    expect(j.launcher.projectRuntime.installed).toBe(true);
    expect(j.launcher.stamps.deps.matchesThisMachine).toBe(true);
    expect(j.launcher.logs.count).toBe(1);
    expect(j.launcher.tunnel.version).toBe("2025.4.2");
    expect(j.launcher.tunnel.matchesManifest).toBe(true);
    expect(j.launcher.tunnel.checksPassed).toContain("macos-codesign:Cloudflare");
  });

  it("pid 文件里的端口与当前配置不一致时要报出来", async () => {
    makeProject();
    fs.writeFileSync(
      path.join(config.projectRoot, ".runtime", "server.pid"),
      JSON.stringify({ pid: process.pid, ports: { local: 9999, public: 9998 } }),
    );
    const app = createLocalApp();
    const cookie = await unlock(app);
    const j: any = await (
      await app.request("/api/local/selftest/env", {
        headers: { ...BROWSER_SAME_ORIGIN, cookie: `${CONTROL_COOKIE_NAME}=${cookie}` },
      })
    ).json();
    expect(j.launcher.pidFile.pointsAtThisProcess).toBe(true);
    expect(j.launcher.pidFile.portsMatch).toBe(false);
  });

  it("B 入口上的 A 控制接口由服务端代探（页面自己发不出去）", async () => {
    makeProject();
    // 必须把端口钉死在没人听的地方。本机 8788 上可能正跑着一套开发实例，
    // 不隔开的话这条测的是「我机器此刻有没有服务」，不是被测代码。
    config.publicPort = 1;
    const app = createLocalApp();
    const cookie = await unlock(app);
    const j: any = await (
      await app.request("/api/local/selftest/env", {
        headers: { ...BROWSER_SAME_ORIGIN, cookie: `${CONTROL_COOKIE_NAME}=${cookie}` },
      })
    ).json();
    // 夹具没有真起 B 进程，所以这里只能验「形状」：字段必须在，且不能谎报可达。
    expect(j.publicProbe).toHaveProperty("localRouteStatus");
    expect(j.publicProbe.reachable).toBe(false);
  });

  it("日志里真漏了令牌时命中数不为 0（这条检查不是自嗨）", async () => {
    makeProject({ logWithToken: true });
    const app = createLocalApp();
    const cookie = await unlock(app);
    const j: any = await (
      await app.request("/api/local/selftest/env", {
        headers: { ...BROWSER_SAME_ORIGIN, cookie: `${CONTROL_COOKIE_NAME}=${cookie}` },
      })
    ).json();
    expect(j.launcher.logs.count).toBe(2);
    expect(j.launcher.logs.tokenHexHits).toBe(1);
  });

  it("pid 文件撒谎（指向一个不存在的进程）时要看得出来", async () => {
    makeProject();
    fs.writeFileSync(
      path.join(config.projectRoot, ".runtime", "server.pid"),
      JSON.stringify({
        pid: 999999,
        ports: { local: config.localPort, public: config.publicPort },
      }),
    );
    const app = createLocalApp();
    const cookie = await unlock(app);
    const j: any = await (
      await app.request("/api/local/selftest/env", {
        headers: { ...BROWSER_SAME_ORIGIN, cookie: `${CONTROL_COOKIE_NAME}=${cookie}` },
      })
    ).json();
    expect(j.launcher.pidFile.exists).toBe(true);
    expect(j.launcher.pidFile.pointsAtThisProcess).toBe(false);
    expect(j.launcher.pidFile.processAlive).toBe(false);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

// 阶段5 档1：起停脚本的流程测试（开发文档 §六档1：「端口与实例三分支」「令牌只经 env」
// 「失败路径不动 .env.local 与 SQLite」「日志只留最近几份」）。
//
// 做法：给 start()/stop() 注入假 spawn、假探活响应和临时目录，于是「真的把服务拉起来」
// 这一步是假的，其余判定（端口、锁、令牌交接、退出码、产物检查、清理）全真。
// 真起服务的端到端路径由 scripts/e2e-startup.mjs（档2）覆盖。

const start = await import("../../scripts/start.mjs");
const stopMod = await import("../../scripts/stop.mjs");
const lib = await import("../../scripts/lib.mjs");

const EXIT = lib.EXIT;

const tempDirs: string[] = [];
function tempDir(prefix = "aiwindow-proc-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** 一个只会按预设方式答话的假服务，用来占住端口。 */
async function fakeServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { port, close: () => new Promise((r) => server.close(r)) };
}

function respondJson(body: unknown, status = 200) {
  return (_req: http.IncomingMessage, res: http.ServerResponse) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
}

/** 起停脚本共用的临时沙箱：pid / lock / log 全在临时目录里，绝不动仓库的 .runtime。 */
function sandbox() {
  const root = tempDir();
  const runtimeDir = path.join(root, ".runtime");
  const logDir = path.join(root, "logs");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  // 失败路径断言要用：假装存在 .env.local 与 sqlite
  fs.writeFileSync(path.join(root, ".env.local"), "USER_MODEL_API_KEY=不许动\n");
  fs.writeFileSync(path.join(runtimeDir, "data.sqlite"), "不许动");
  return {
    root,
    runtimeDir,
    logDir,
    pidFile: path.join(runtimeDir, "server.pid"),
    lockFile: path.join(runtimeDir, "start.lock"),
    envFile: path.join(root, ".env.local"),
    dbFile: path.join(runtimeDir, "data.sqlite"),
  };
}

function snapshotUnchanged(box: any) {
  return () => ({
    env: fs.readFileSync(box.envFile, "utf8"),
    db: fs.readFileSync(box.dbFile, "utf8"),
  });
}

/** 记录被 spawn 的调用；返回一个假 child（有 pid / kill / on / unref）。 */
function fakeSpawn(calls: any[] = [], pid = 4242) {
  return (_exe: string, args: string[], opts: any) => {
    const child: any = new EventEmitter();
    child.pid = pid;
    child.kill = () => true;
    child.unref = () => {};
    child.ref = () => {};
    calls.push({ exe: _exe, args, opts });
    return child;
  };
}

function baseOptions(over: any = {}) {
  const box = sandbox();
  const options = {
    root: box.root,
    pidFile: box.pidFile,
    lockFile: box.lockFile,
    logDir: box.logDir,
    ports: { local: 18787, public: 18788 },
    env: { PATH: "/usr/bin" },
    log: () => {},
    lock: { acquired: true },
    build: { ok: true },
    preflight: () => ({ ok: true, problems: [] }),
    waitHealth: async () => ({ ok: true }),
    openBrowser: () => ({ ok: true, file: "" }),
    spawn: fakeSpawn(),
    foreground: false,
    token: "c".repeat(64),
    manifest: lib.loadManifest(),
    target: lib.platformTarget(),
    nodeExe: "/tmp/fake-node",
    ...over,
  };
  return { box, options };
}

describe("启动流程：全绿路径", () => {
  it("令牌只经子进程环境变量传入，argv 与日志里都不出现", async () => {
    const calls: any[] = [];
    const { options } = baseOptions({ spawn: fakeSpawn(calls) });
    const result = await start.start(options);

    expect(result.code).toBe(EXIT.OK);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    // argv 里只有入口文件，没有任何 --token 之类的形态
    expect(call.args).toEqual([start.SERVER_ENTRY]);
    expect(JSON.stringify(call.args)).not.toContain(options.token);
    // 令牌与「来自启动器」的标记成对出现（服务端两个键都要看到才认）
    expect(call.opts.env.LOCAL_CONTROL_TOKEN_SECRET).toBe(options.token);
    expect(call.opts.env.AIWINDOW_LAUNCHER_TOKEN).toBe("1");
    expect(call.opts.env.NODE_ENV).toBe("production");
    // cwd 必须是 coding/：Skill 与 .env 的相对路径都以它为基准
    expect(call.opts.cwd).toBe(path.join(lib.CODING_DIR));
    // 用项目专用 Node，而不是 PATH 里那个
    expect(call.exe).toBe(options.nodeExe);
    // 项目 Node 的 bin 目录排在 PATH 最前面（npm/npx 也要用对的那一份）
    expect(call.opts.env.PATH.split(path.delimiter)[0]).toBe(
      lib.nodeBinDir(options.target, options.manifest),
    );
    // 日志文件里没有令牌（stdio 已经指向它）
    const logged = fs.existsSync(result.logFile)
      ? fs.readFileSync(result.logFile, "utf8")
      : "";
    expect(logged).not.toContain(options.token);
  });

  it("pid 文件记下 stop 复核要用的信息", async () => {
    const { box, options } = baseOptions();
    const result = await start.start(options);
    expect(result.code).toBe(EXIT.OK);
    const record = JSON.parse(fs.readFileSync(box.pidFile, "utf8"));
    expect(record).toMatchObject({
      pid: 4242,
      nodeExe: options.nodeExe,
      ports: { local: 18787, public: 18788 },
    });
    expect(path.basename(record.entry)).toBe("index.js");
    expect(Number.isFinite(record.startedAt)).toBe(true);
  });

  it("--no-open 时把一次性地址打给用户但不自己弹浏览器", async () => {
    const opened: string[] = [];
    const { options } = baseOptions({
      open: false,
      openBrowser: (url: string) => {
        opened.push(url);
        return { ok: true, file: "" };
      },
    });
    const chunks: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: any) => {
      chunks.push(String(s));
      return true;
    }) as any;
    try {
      await start.start(options);
    } finally {
      process.stdout.write = write as any;
    }
    const out = chunks.join("");
    expect(opened).toHaveLength(0);
    // 这条路径本来就要把地址念出来给人工兜底
    expect(out).toContain("一次性引导地址");
    expect(out).not.toContain("undefined");
  });

  it("自动打开失败时退回「把地址念出来」，不让 A 对着一个空白屏幕", async () => {
    const { options } = baseOptions({
      openBrowser: () => ({ ok: false, reason: "NO_BROWSER" }),
    });
    const chunks: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: any) => {
      chunks.push(String(s));
      return true;
    }) as any;
    try {
      const result = await start.start(options);
      expect(result.code).toBe(EXIT.OK);
    } finally {
      process.stdout.write = write as any;
    }
    expect(chunks.join("")).toContain(`http://127.0.0.1:18787/api/local/bootstrap/`);
  });

  it("日志只保留最近 5 份，旧的删掉", async () => {
    const { box, options } = baseOptions();
    for (let i = 1; i <= 9; i++) {
      fs.writeFileSync(
        path.join(box.logDir, `run-2026-01-0${i}T00-00-00.log`),
        `old-${i}`,
      );
    }
    const result = await start.start({ ...options, keepLogs: true });
    expect(result.code).toBe(EXIT.OK);
    const left = fs.readdirSync(box.logDir).filter((f) => f.startsWith("run-"));
    expect(left.length).toBeLessThanOrEqual(5);
    // 留下的是最近的，不是最早那批
    expect(left.some((f) => f.includes("2026-01-09"))).toBe(true);
    expect(left.some((f) => f.includes("2026-01-01"))).toBe(false);
  });

  it("--fresh-logs 全清（档2 用，防止上一次的日志混进本次判定）", () => {
    const dir = tempDir();
    for (let i = 1; i <= 3; i++)
      fs.writeFileSync(path.join(dir, `run-2026-01-0${i}T00-00-00.log`), "x");
    const file = start.startLogfile(false, dir);
    expect(fs.readdirSync(dir)).toEqual([path.basename(file)]);
  });
});

describe("启动流程：端口与实例三分支（PRD §12.2 第 11、12 条）", () => {
  it("8787 上是本项目在跑（health 回显对得上）→ 不起新进程，重新打开工作台", async () => {
    const srv = await fakeServer((_req, res) => {
      const url = new URL(_req.url ?? "/", "http://127.0.0.1");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          service: "a",
          probe: url.searchParams.get("probe"),
        }),
      );
    });
    const calls: any[] = [];
    const opened: string[] = [];
    const { options } = baseOptions({
      ports: { local: srv.port, public: srv.port },
      spawn: fakeSpawn(calls),
      openBrowser: (url: string) => {
        opened.push(url);
        return { ok: true, file: "" };
      },
    });
    const result = await start.start(options);
    try {
      expect(result.code).toBe(EXIT.ALREADY_RUNNING);
      expect(calls).toHaveLength(0); // 绝不重复起
      expect(opened).toEqual([`http://127.0.0.1:${srv.port}/`]);
      // 关键：不复用上次的一次性令牌（我们也不知道它），只开根路径靠 Cookie 续命
      expect(opened[0]).not.toContain("/api/local/bootstrap/");
      expect(opened[0]).not.toContain(options.token);
    } finally {
      await srv.close();
    }
  });

  it("8787 上是「别人的 200」（回显对不上）→ 判为 foreign，不接管也不 kill", async () => {
    // 别的程序也在 /api/local/health 上回 JSON，但没有我们的 probe：
    // 这正是缓存/代理/同名服务想骗过探活的那张脸。
    const srv = await fakeServer(
      respondJson({ ok: true, service: "a", probe: "basic" }),
    );
    const calls: any[] = [];
    const { options } = baseOptions({
      ports: { local: srv.port, public: srv.port },
      spawn: fakeSpawn(calls),
    });
    const result = await start.start(options);
    try {
      expect(result.code).toBe(EXIT.PORT);
      expect(calls).toHaveLength(0);
      expect(result.message).toContain(String(srv.port));
      expect(result.hint).toContain("不会替你 kill");
    } finally {
      await srv.close();
    }
  });

  it("8788 被占（A 空着）→ EXIT.PORT，提示改 PUBLIC_PORT", async () => {
    const srv = await fakeServer(respondJson({ hello: "world" }));
    const calls: any[] = [];
    const { box, options } = baseOptions({
      ports: { local: 18787, public: srv.port },
      spawn: fakeSpawn(calls),
    });
    const before = snapshotUnchanged(box)();
    const result = await start.start(options);
    try {
      expect(result.code).toBe(EXIT.PORT);
      expect(calls).toHaveLength(0);
      expect(result.message).toContain(String(srv.port));
      expect(result.hint).toContain("PUBLIC_PORT");
      // 失败路径不动用户数据（§5.12）
      expect(snapshotUnchanged(box)()).toEqual(before);
    } finally {
      await srv.close();
    }
  });

  it("探活函数自己：三种情况分得清", async () => {
    const probe = start.newProbe();
    expect(probe).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    const ours = await fakeServer((_req, res) => {
      const url = new URL(_req.url ?? "/", "http://127.0.0.1");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          service: "a",
          probe: url.searchParams.get("probe"),
        }),
      );
    });
    const wrongEcho = await fakeServer(
      respondJson({ ok: true, service: "a", probe: "别人缓存的" }),
    );
    const notFound = await fakeServer(respondJson({ error: "NOT_FOUND" }, 404));
    try {
      expect(
        (await start.detectLocalInstance({ local: ours.port, public: 0 }, { probe }))
          .kind,
      ).toBe("ours");
      expect(
        (
          await start.detectLocalInstance({ local: wrongEcho.port, public: 0 }, { probe })
        ).kind,
      ).toBe("foreign");
      expect(
        (await start.detectLocalInstance({ local: notFound.port, public: 0 }, { probe }))
          .kind,
      ).toBe("foreign");
      // 端口空着才是 free
      expect(
        (await start.detectLocalInstance({ local: 1, public: 1 }, { probe })).kind,
      ).toBe("free");
      // B 侧同理，认的是 service=b
      const b = await fakeServer((_req, res) => {
        const url = new URL(_req.url ?? "/", "http://127.0.0.1");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            service: "b",
            probe: url.searchParams.get("probe"),
          }),
        );
      });
      try {
        expect(
          (
            await start.detectPublicInstance({ local: 1, public: b.port }, { probe })
          ).kind,
        ).toBe("ours");
        // A 冒充 B（同一个进程同时挂了两个端口的偷懒实现）要能被识破
        expect(
          (
            await start.detectPublicInstance(
              { local: ours.port, public: ours.port },
              { probe },
            )
          ).kind,
        ).toBe("foreign");
      } finally {
        await b.close();
      }
    } finally {
      await ours.close();
      await wrongEcho.close();
      await notFound.close();
    }
  });

  it("waitHealthy 要两边都回显同一个 probe 才算就绪", async () => {
    const probe = "zz9_-abc";
    const a = await fakeServer((_req, res) => {
      const url = new URL(_req.url ?? "/", "http://127.0.0.1");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ ok: true, service: "a", probe: url.searchParams.get("probe") }),
      );
    });
    const b = await fakeServer((_req, res) => {
      const url = new URL(_req.url ?? "/", "http://127.0.0.1");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ ok: true, service: "b", probe: url.searchParams.get("probe") }),
      );
    });
    try {
      expect(
        (
          await start.waitHealthy({ local: a.port, public: b.port }, Date.now() + 3000, {
            probe,
          })
        ).ok,
      ).toBe(true);
      // B 没起来 → 超时，不能因为 A 活着就宣布就绪
      const down = await start.waitHealthy(
        { local: a.port, public: 1 },
        Date.now() + 600,
        { intervalMs: 100, probe },
      );
      expect(down.ok).toBe(false);
      expect(down.reason).toContain("TIMEOUT");
    } finally {
      await a.close();
      await b.close();
    }
  });
});

describe("启动流程：失败路径与清理", () => {
  it("从错误的目录跑（自检不过）→ EXIT.ENV，且不动用户数据", async () => {
    const { box, options } = baseOptions({
      root: tempDir(), // 一个啥都没有的空目录
      preflight: undefined,
    });
    const before = snapshotUnchanged(box)();
    const result = await start.start(options);
    expect(result.code).toBe(EXIT.ENV);
    expect(result.message).toContain("自检");
    expect(snapshotUnchanged(box)()).toEqual(before);
    expect(fs.existsSync(box.pidFile)).toBe(false);
  });

  it("构建产物缺失 → EXIT.BUILD，并说明跑 prepare-deps", async () => {
    const { box, options } = baseOptions({
      build: { ok: false, missing: ["dist/server/index.js"] },
    });
    const before = snapshotUnchanged(box)();
    const result = await start.start(options);
    expect(result.code).toBe(EXIT.BUILD);
    expect(result.hint).toContain("prepare-deps");
    expect(snapshotUnchanged(box)()).toEqual(before);
    expect(fs.existsSync(box.pidFile)).toBe(false);
  });

  it("健康检查超时 → 收掉刚起的子进程，不留 pid 文件", async () => {
    let killed: string | undefined;
    const child: any = new EventEmitter();
    child.pid = 4321;
    child.kill = (signal: string) => {
      killed = signal;
      return true;
    };
    const { box, options } = baseOptions({
      spawn: () => child,
      waitHealth: async () => ({ ok: false, reason: "TIMEOUT a=down b=down" }),
    });
    const result = await start.start(options);
    expect(result.code).toBe(EXIT.ENV);
    expect(result.message).toContain("健康检查没过");
    expect(killed).toBe("SIGTERM"); // 只发 TERM，不 -9
    expect(fs.existsSync(box.pidFile)).toBe(false);
  });

  it("别人持有启动锁 → ALREADY_RUNNING，不起进程", async () => {
    const calls: any[] = [];
    const { box, options } = baseOptions({
      lock: { acquired: false, reason: "LOCK_HELD" },
      spawn: fakeSpawn(calls),
    });
    const result = await start.start(options);
    expect(result.code).toBe(EXIT.ALREADY_RUNNING);
    expect(calls).toHaveLength(0);
    expect(fs.existsSync(box.pidFile)).toBe(false);
  });

  it("pid 文件里那个 PID 其实还活着 → 直接说已在跑，不去抢", async () => {
    const { box, options } = baseOptions();
    fs.writeFileSync(
      box.pidFile,
      JSON.stringify({ pid: process.pid, entry: start.SERVER_ENTRY, nodeExe: "x", ports: {} }),
    );
    const result = await start.start(options);
    expect(result.code).toBe(EXIT.ALREADY_RUNNING);
    expect(result.message).toContain(String(process.pid));
  });

  it("陈旧的 pid 文件（进程早没了）→ 删掉再继续，不把 A 卡死", async () => {
    const { box, options } = baseOptions();
    fs.writeFileSync(box.pidFile, JSON.stringify({ pid: 999999 }));
    const result = await start.start(options);
    expect(result.code).toBe(EXIT.OK);
    expect(JSON.parse(fs.readFileSync(box.pidFile, "utf8")).pid).toBe(4242);
  });

  it("锁的独占与陈旧回收", () => {
    const file = path.join(tempDir(), "start.lock");
    expect(start.acquireLock(file).acquired).toBe(true);
    // 同一个 pid（就是本测试进程）还活着 → 抢不到
    expect(start.acquireLock(file).acquired).toBe(false);
    start.releaseLock(file);
    expect(fs.existsSync(file)).toBe(false);
    // 别人的锁，但进程号已经不存在 → 抢过来（崩溃残留不能让 A 永远起不来）
    fs.writeFileSync(file, JSON.stringify({ pid: 999999, at: new Date().toISOString() }));
    expect(start.acquireLock(file).acquired).toBe(true);
    // 太老的锁即使进程号被回收也照抢
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: "2020-01-01T00:00:00Z" }));
    fs.utimesSync(file, new Date(2020, 0, 1), new Date(2020, 0, 1));
    expect(start.acquireLock(file).acquired).toBe(true);
    start.releaseLock(file);
  });

  it("releaseLock 不动别人持有的锁", () => {
    const file = path.join(tempDir(), "start.lock");
    fs.writeFileSync(file, JSON.stringify({ pid: 999999 }));
    start.releaseLock(file);
    expect(fs.existsSync(file)).toBe(true);
  });
});

describe("打开浏览器那一步（§5.7 的暴露面）", () => {
  it("地址写在 0600 的临时文件里，不出现在 argv", () => {
    const dir = tempDir("aiwindow-open-");
    const token = "d".repeat(64);
    const url = `http://127.0.0.1:8787/api/local/bootstrap/${token}`;
    // platform 传 win32：这台机器上没有 cmd，spawn 会失败并被吞掉，
    // 正好验证「开不动也不炸，且文件仍然按 0600 建出来」。
    const result = start.openInBrowser(url, { platform: "win32", tmpDir: dir });
    expect(result.ok).toBe(true);
    const mode = (fs.statSync(result.file).mode & 0o777).toString(8);
    expect(mode).toBe("600");
    expect(fs.readFileSync(result.file, "utf8")).toContain(url);
    // 文件名里没有令牌（令牌只在内容里，且文件几秒后就被删）
    expect(path.basename(result.file)).not.toContain(token);
  });

  it("写不出来时返回失败而不是抛异常（脚本要能退化成把地址念出来）", () => {
    const result = start.openInBrowser("http://127.0.0.1:8787/", {
      platform: "darwin",
      tmpDir: path.join(tempDir(), "不存在的子目录"),
    });
    expect(result.ok).toBe(false);
    expect(typeof result.reason).toBe("string");
  });
});

describe("启动前自检 preflightCheck（§5.4）", () => {
  it("仓库根目录一切齐全 → ok", () => {
    const check = start.preflightCheck({ root: lib.REPO_ROOT });
    expect(check.ok, JSON.stringify(check.problems)).toBe(true);
  });

  it("在 coding/ 里跑（少了上层结构）→ 报缺 Skill 配置，不是一句「找不到文件」", () => {
    const check = start.preflightCheck({ root: path.join(lib.REPO_ROOT, "coding") });
    expect(check.ok).toBe(false);
    expect(check.problems.join("；")).toContain("package.json");
  });

  it("Skill 目录被删掉 → 指名道姓说缺哪个", () => {
    const root = tempDir("aiwindow-preflight-");
    fs.mkdirSync(path.join(root, "coding"), { recursive: true });
    fs.writeFileSync(path.join(root, "coding", "package.json"), "{}");
    fs.mkdirSync(path.join(root, "coding", "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(root, ".env.example"), "A=1\n");
    fs.writeFileSync(path.join(root, "runtime-manifest.json"), "{}");
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "config", "skills.json"),
      JSON.stringify({
        aiStyleSkillPath: "skills/ai-style",
        analysisSkillPath: "skills/missing-one",
      }),
    );
    fs.mkdirSync(path.join(root, "skills", "ai-style"), { recursive: true });
    const check = start.preflightCheck({ root });
    expect(check.ok).toBe(false);
    expect(check.problems.join("；")).toContain("skills/missing-one");
    // 不能把本机绝对路径写进给用户的话里
    expect(check.problems.join("；")).not.toContain(root);
  });

  it("skills.json 写坏 → 一句人话，不甩堆栈", () => {
    const root = tempDir("aiwindow-preflight-");
    fs.mkdirSync(path.join(root, "coding"), { recursive: true });
    fs.writeFileSync(path.join(root, "coding", "package.json"), "{}");
    fs.mkdirSync(path.join(root, "coding", "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(root, ".env.example"), "A=1\n");
    fs.writeFileSync(path.join(root, "runtime-manifest.json"), "{}");
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.writeFileSync(path.join(root, "config", "skills.json"), "{ 坏的");
    const check = start.preflightCheck({ root });
    expect(check.ok).toBe(false);
    expect(check.problems.join("；")).toContain("config/skills.json");
    expect(check.problems.join("；")).not.toMatch(/Error:|at .*\.js/);
  });
});

describe("停止流程（§5.5）", () => {
  it("认得出来的进程只发 SIGTERM，不 -9，之后删 pid 与 lock", async () => {
    const { box, options } = baseOptions();
    await start.start({ ...options, lock: undefined, openBrowser: () => ({ ok: true, file: "" }) });
    fs.writeFileSync(box.lockFile, JSON.stringify({ pid: process.pid }));
    const killed: Array<[number, string]> = [];
    const result = await stopMod.stop({
      pidFile: box.pidFile,
      lockFile: box.lockFile,
      ports: { local: 1, public: 2 }, // 端口上没有东西 = 已释放
      platform: "darwin",
      verify: () => ({ ours: true }),
      kill: (pid: number, signal: string) => {
        killed.push([pid, signal]);
      },
      timeoutMs: 300,
    });
    expect(killed).toEqual([[4242, "SIGTERM"]]);
    expect(killed.some(([, s]) => String(s).includes("KILL"))).toBe(false);
    expect(result.code).toBe(EXIT.OK);
    expect(fs.existsSync(box.pidFile)).toBe(false);
    expect(fs.existsSync(box.lockFile)).toBe(false);
  });

  it("复核不出归属（PID 被回收复用）→ 什么都不杀", async () => {
    const box = sandbox();
    fs.writeFileSync(
      box.pidFile,
      JSON.stringify({ pid: process.pid, entry: "/somewhere/other.js", nodeExe: "x" }),
    );
    const killed: number[] = [];
    const result = await stopMod.stop({
      ports: { local: 1, public: 2 },
      pidFile: box.pidFile,
      verify: () => ({ ours: false, reason: "NO_ENTRY" }),
      kill: (pid: number) => {
        killed.push(pid);
      },
      timeoutMs: 200,
    });
    expect(killed).toEqual([]);
    expect(result.code).toBe(EXIT.ENV);
    expect(result.message).toContain("不会去杀它");
    expect(result.hint).toContain("server.pid");
  });

  it("没有 pid 文件但端口上有本项目的服务 → 不擅自动手，告诉人去关窗口", async () => {
    const result = await stopMod.stop({
      ports: { local: 1, public: 2 },
      pidFile: path.join(tempDir(), "nothing.pid"),
      readPidFile: () => null,
      timeoutMs: 200,
    });
    expect(result.code).toBe(EXIT.ALREADY_RUNNING);
    expect(result.message).toContain("没有在跑的实例");
  });

  it("进程收了但端口没空 → 明确说出来，不让 A 以为已经停干净", async () => {
    const srv = await fakeServer(respondJson({ ok: true, service: "a" }));
    const box = sandbox();
    const result = await stopMod.stop({
      pidFile: box.pidFile,
      lockFile: box.lockFile,
      ports: { local: srv.port, public: srv.port },
      platform: "darwin",
      readPidFile: () => ({
        pid: 4242,
        entry: start.SERVER_ENTRY,
        nodeExe: "/tmp/fake-node",
        ports: { local: srv.port, public: srv.port },
      }),
      verify: () => ({ ours: true }),
      kill: () => {},
      timeoutMs: 400,
    });
    await srv.close();
    expect(result.code).toBe(EXIT.ENV);
    expect(result.message).toContain("端口还没空");
  });

  it("verifyOwnership 看的是命令行形状：光有 PID 不算", () => {
    expect(stopMod.verifyOwnership(null).ours).toBe(false);
    expect(stopMod.verifyOwnership({ pid: 1 }).ours).toBe(false);
    expect(
      stopMod.verifyOwnership({ pid: process.pid, entry: "other.js", nodeExe: "x" })
        .ours,
    ).toBe(false);
    // 我们自己这个测试进程的命令行里没有 index.js → 认不出，正确
    expect(
      stopMod.verifyOwnership(
        { pid: process.pid, entry: start.SERVER_ENTRY, nodeExe: process.execPath },
        { platform: process.platform },
      ).ours,
    ).toBe(false);
  });
});

describe("退出码约定（§4）", () => {
  it("六个码各就各位，脚本之间不会串", () => {
    expect(EXIT).toMatchObject({ OK: 0, ENV: 3, PORT: 4, ALREADY_RUNNING: 5, BUILD: 6 });
    expect(lib.isMain).toBeTypeOf("function");
  });

  it("die() 用退出码表把码翻成人话", async () => {
    const chunks: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: any) => {
      chunks.push(String(s));
      return true;
    }) as any;
    try {
      expect(lib.die(EXIT.PORT, "端口被占")).toBe(EXIT.PORT);
    } finally {
      process.stderr.write = write as any;
    }
    expect(chunks.join("")).toContain("端口被占");
  });
});

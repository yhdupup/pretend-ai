#!/usr/bin/env node
// 阶段5 档2：无公网端到端（开发文档 §六 档2）。
//
// 它和档1 的分工：档1 用注入的假 spawn / 假探活验判定分支；这个脚本用**真进程 + 真端口 + 真 HTTP**
// 验「装好之后的一切」——临时目录里复制出一份完整项目，让真脚本在那儿跑到底。
//
// 边界（写在签收材料里，不遮掩）：
// - 用当前机器上已有的 Node 执行准备层，覆盖不到真下载与真签名校验（那是档3 手工清单的活）。
// - 不连公网：隧道一律 TUNNEL_AUTOSTART=false 关掉，模型凭证显式置空。
// - 不碰开发者真东西：全程只在 mkdtemp 的临时项目里读写，仓库的 .runtime / data / logs 只读比对。
//
// 用法：npm run e2e:startup

import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CODING = path.resolve(HERE, "..");
const REPO = path.resolve(CODING, "..");

const verify = await import(path.join(REPO, "scripts", "verify-runtime.mjs"));
const lib = await import(path.join(REPO, "scripts", "lib.mjs"));
const EXIT = lib.EXIT;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const notes = [];

function check(label, ok, extra) {
  const suffix =
    extra === undefined ? "" : ` → ${typeof extra === "string" ? extra : JSON.stringify(extra)}`;
  console.log(`${ok ? "✅" : "❌"} ${label}${suffix}`);
  if (!ok) failures.push(label);
}

function note(text) {
  notes.push(text);
  console.log(`    ℹ️  ${text}`);
}

/**
 * 一次拿到**一对**互不相同、且当下真的能同时监听的端口。
 *
 * 原先这里是 `await freePort()` 调两次。听起来没问题，实际会翻车：
 * 第一次拿到的端口在 close 之后马上又被第二次 listen(0) 发回来，
 * 于是 LOCAL_PORT == PUBLIC_PORT，启动脚本报的是「端口被占用」，
 * 而看日志的人以为是启动脚本写错了（现场排查过一次，元凶是上一轮残留的服务进程）。
 * 现在两个 socket 一起 bind，成功才一起放开。
 */
function freePortPair() {
  return new Promise((resolve, reject) => {
    const a = net.createServer();
    a.listen(0, "127.0.0.1", () => {
      const local = a.address().port;
      const b = net.createServer();
      b.once("error", () => {
        a.close();
        // 罕见：刚拿到的端口对下一格被人占着（比如本机有服务在监听 port+1）。换个端口重来一次。
        freePortPair().then(resolve, reject);
      });
      b.listen(local + 1, "127.0.0.1", () => {
        const publicPort = b.address().port;
        let done = 0;
        const fin = () => {
          if (++done === 2) resolve({ local, public: publicPort });
        };
        a.close(fin);
        b.close(fin);
      });
    });
    a.once("error", reject);
  });
}

// ---------- 造一个「装好的项目」 ----------

const COPY_FILES = [
  "runtime-manifest.json",
  ".env.example",
  "config/skills.json",
  "coding/package.json",
  "coding/package-lock.json",
];
const COPY_DIRS = ["scripts", "coding/dist", "增加ai味skill", "深度思考反推skill"];
const ASSET_DIRS = [
  "coding/apps/a-frontend/dist",
  "coding/apps/b-frontend/dist",
  "coding/apps/a-frontend/index.html",
  "coding/apps/b-frontend/index.html",
];

function cp(from, to) {
  const st = fs.statSync(from);
  if (st.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) cp(path.join(from, name), path.join(to, name));
  } else fs.copyFileSync(from, to);
}

/**
 * 复制出一个可用的项目根。装好的状态是「造」出来的：
 * Node 用符号链接指向本机那份（不拷 100MB），依赖 stamp 与构建 stamp 按当前内容现算，
 * 于是准备层看到的是「都已经就绪」，跑的就是状态机的后半段。
 */
function makeProject({ dist = true, brokenNode = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiwindow-e2e-"));
  for (const rel of COPY_FILES) {
    const from = path.join(REPO, rel);
    if (!fs.existsSync(from)) throw new Error(`模板项目缺文件：${rel}`);
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.copyFileSync(from, path.join(root, rel));
  }
  for (const rel of COPY_DIRS) {
    if (rel === "coding/dist" && !dist) continue;
    const from = path.join(REPO, rel);
    if (fs.existsSync(from)) cp(from, path.join(root, rel));
  }
  if (dist) for (const rel of ASSET_DIRS) cp(path.join(REPO, rel), path.join(root, rel));

  fs.mkdirSync(path.join(root, "coding"), { recursive: true });
  fs.symlinkSync(
    path.join(CODING, "node_modules"),
    path.join(root, "coding", "node_modules"),
    "dir",
  );

  const manifest = lib.loadManifest(path.join(root, "runtime-manifest.json"));
  const target = lib.platformTarget();
  const nodeRoot = path.join(root, ".runtime", "node", manifest.nodeTag);
  fs.mkdirSync(nodeRoot, { recursive: true });
  const link = path.join(nodeRoot, target);
  if (brokenNode) {
    // 故意放一个「文件在但跑不起来」的 node：比没装更糟的情况必须被抓出来。
    fs.mkdirSync(path.join(link, "bin"), { recursive: true });
    fs.writeFileSync(
      path.join(link, "bin", "node"),
      `#!/bin/sh\nexit 3\n`,
      { mode: 0o755 },
    );
  } else {
    fs.symlinkSync(path.join(REPO, ".runtime", "node", manifest.nodeTag, target), link, "dir");
  }

  // 用户自己的东西：失败路径必须证明没动它们
  fs.writeFileSync(
    path.join(root, ".env.local"),
    "USER_MODEL_API_KEY=e2e-sentinel-key\nA_STORAGE_KEY=e2e-sentinel-storage\n",
  );
  const runtimeDir = path.join(root, ".runtime");
  const codingDir = path.join(root, "coding");
  fs.mkdirSync(runtimeDir, { recursive: true });
  if (!brokenNode) {
    lib.writeStamp(
      "deps",
      {
        depsKey: verify.depsKey(codingDir),
        nodeVersion: manifest.nodeTag,
        platform: process.platform,
        arch: process.arch,
      },
      runtimeDir,
    );
    lib.writeStamp(
      "build",
      { sourceKey: verify.sourceKey(codingDir), parts: verify.checkBuild(codingDir) },
      runtimeDir,
    );
  }
  return { root, runtimeDir, codingDir, manifest, target };
}

function runScript(root, script, args = [], env = {}) {
  return spawnSync(process.execPath, [path.join(root, script), ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 180_000,
    env: { ...process.env, ...env },
  });
}

/**
 * 异步跑一个脚本并收集输出。
 * 为什么要有这个而不是全用 spawnSync：有些用例的被测对象是本进程里的假服务（占端口的、
 * 答健康检查的），spawnSync 会把事件循环冻住 —— 假服务答不上话，探活就误判成「端口空着」。
 */
function runScriptAsync(root, script, args = [], env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, script), ...args], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

function spawnScript(root, script, args = [], env = {}) {
  const child = spawn(process.execPath, [path.join(root, script), ...args], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  spawned.push(child);
  return child;
}

async function probeHealth(port, service, timeoutMs = 25_000) {
  const endpoint = service === "a" ? "api/local/health" : "api/public/health";
  const probe = `e2e${Math.random().toString(36).slice(2, 10)}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/${endpoint}?probe=${probe}`);
      const body = await res.json().catch(() => null);
      if (body?.service === service && body?.probe === probe) return { ok: true, body };
    } catch {
      /* 还没起来 */
    }
    await sleep(200);
  }
  return { ok: false };
}

const tempRoots = [];
/** 本脚本起过的所有启动器进程；退出时一律收掉（服务进程是它的子进程，会跟着走）。 */
const spawned = [];
/** 轮询等一个条件成立（不是断言，只是给断言创造稳定的观察点）。 */
async function waitUntil(fn, timeoutMs = 10_000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(intervalMs);
  }
  return false;
}

function cleanup() {
  for (const child of spawned) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* 早就退了 */
    }
  }
  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true });
}

// ---------- 开跑 ----------

async function main() {
  const realPid = path.join(REPO, ".runtime", "server.pid");
  const beforeRealPid = fs.existsSync(realPid) ? fs.readFileSync(realPid, "utf8") : null;

  // 前置条件：本仓库已经构建过（档2 测的是启动脚本，不是构建）
  if (!verify.checkBuild(CODING).ok) {
    console.error("❌ 前置条件不满足：coding/dist 不存在。先跑 npm run build 再执行本脚本。");
    return 2;
  }

  console.log("\n== 1/5 全绿路径：临时项目里跑到 READY，再走 stop 收尾 ==");
  const { local: localPort, public: publicPort } = await freePortPair();
  const project = makeProject();
  tempRoots.push(project.root);
  const env = {
    LOCAL_PORT: String(localPort),
    PUBLIC_PORT: String(publicPort),
    TUNNEL_AUTOSTART: "false", // 档2 不碰公网
    USER_MODEL_API_KEY: "", // 屏蔽 .env.local 里的真凭证，结论与开发机无关
    USER_MODEL_BASE_URL: "",
    USER_MODEL_ID: "",
  };

  const child = spawnScript(project.root, "scripts/bootstrap.mjs", ["--no-open"], env);
  let out = "";
  child.stdout.on("data", (chunk) => {
    out += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    out += chunk.toString();
  });

  const a = await probeHealth(localPort, "a", 60_000);
  check("A 入口健康检查通过（probe 回显对得上）", a.ok);
  const b = await probeHealth(publicPort, "b", 60_000);
  check("B 入口健康检查通过", b.ok);
  // 端口通了 ≠ 启动器已经报到 READY：服务一 listen 就能探到，而启动器自己那轮健康检查
  // 还没轮到（机器忙的时候能差一秒多）。这里必须等「那句话真的打出来」，
  // 不能拿上一行的探针结论代替它 —— 否则测的是时序运气，不是行为。
  await waitUntil(() => /READY|就绪/.test(out), 20_000);
  check("bootstrap 一路跑到 READY", /READY|就绪/.test(out), out.slice(-160).trim());

  if (a.ok) {
    const page = await fetch(`http://127.0.0.1:${localPort}/`);
    const html = await page.text();
    check(
      "GET / 直接发工作台壳（no-store）",
      page.status === 200 &&
        html.includes("<") &&
        page.headers.get("cache-control") === "no-store",
      `${page.status} ${page.headers.get("cache-control")}`,
    );

    const noCookie = await fetch(`http://127.0.0.1:${localPort}/api/local/status`);
    check("没换 Cookie 之前读不到会话状态", noCookie.status === 403, noCookie.status);

    // 一次性引导地址：--no-open 就是设计来把它念给人看的，档2 拿它当 Cookie 兑换的入口
    await waitUntil(
      () => /http:\/\/127\.0\.0\.1:\d+\/api\/local\/bootstrap\/[0-9a-f]{64}/.test(out),
      10_000,
    );
    const bootstrapUrl = (
      out.match(/http:\/\/127\.0\.0\.1:\d+\/api\/local\/bootstrap\/([0-9a-f]{64})/) ?? []
    )[0];
    const token = bootstrapUrl?.split("/").pop() ?? "";
    check("拿到了启动器打印的一次性地址", Boolean(token));

    if (token) {
      // 别的用户/别的进程用 ps 扫命令行，也不该看见令牌（§5.7 的「不进 argv」在这里是真进程）
      const listing = spawnSync("ps", ["-ax", "-o", "args="], { encoding: "utf8" });
      check(
        "令牌不出现在任何进程的命令行里（ps 扫全表）",
        !(listing.stdout ?? "").includes(token),
      );

      const exchange = await fetch(bootstrapUrl, { redirect: "manual" });
      const cookie = (exchange.headers.getSetCookie?.()[0] ??
        exchange.headers.get("set-cookie") ??
        "").split(";")[0];
      check("引导地址能换到控制 Cookie", exchange.status === 200 && cookie.includes("aiwindow_ctrl"));
      if (cookie) {
        const status = await fetch(`http://127.0.0.1:${localPort}/api/local/status`, {
          headers: { cookie, origin: `http://127.0.0.1:${localPort}` },
        });
        check("带 Cookie 之后状态接口 200", status.status === 200, status.status);
      }
      const replay = await fetch(bootstrapUrl, { redirect: "manual" });
      check("同一个引导地址用第二次就失败（一次性）", replay.status === 403, replay.status);
    }

    const bHealth = await fetch(
      `http://127.0.0.1:${publicPort}/api/local/health?probe=x`,
    );
    check("B 入口没有 A 的探针（公网问不到本机控制端）", bHealth.status === 404, bHealth.status);

    const crossOrigin = await fetch(`http://127.0.0.1:${localPort}/api/local/health`, {
      headers: { origin: "https://evil.example" },
    });
    check("网页跨源读不到 A 探针", crossOrigin.status === 403, crossOrigin.status);
  }

  const second = runScript(project.root, "scripts/start.mjs", ["--no-open"], env);
  check("第二次启动不重复起服务（ALREADY_RUNNING=5）", second.status === EXIT.ALREADY_RUNNING, second.status);

  const logsDir = path.join(project.root, "logs");
  const logFiles = fs.existsSync(logsDir) ? fs.readdirSync(logsDir) : [];
  const tokenFromLog = (
    out.match(/bootstrap\/([0-9a-f]{64})/) ?? []
  )[1];
  const logged = logFiles.map((f) => fs.readFileSync(path.join(logsDir, f), "utf8")).join("");
  check(
    "落盘日志里没有一次性令牌",
    Boolean(tokenFromLog) && !logged.includes(tokenFromLog),
    `${logFiles.length} 个日志文件`,
  );
  check("服务写的是临时项目自己的 sqlite", fs.existsSync(path.join(project.codingDir, "data")), "coding/data");

  const stopped = runScript(project.root, "scripts/stop.mjs", [], env);
  check("stop 正常收摊（退出码 0）", stopped.status === EXIT.OK, `${stopped.status} ${(stopped.stdout ?? "").trim().split("\n").pop()}`);
  await waitUntil(
    () =>
      !fs.existsSync(path.join(project.runtimeDir, "server.pid")) &&
      !fs.existsSync(path.join(project.runtimeDir, "start.lock")),
    10_000,
  );
  await sleep(300);
  const aAfter = await probeHealth(localPort, "a", 1500);
  const bAfter = await probeHealth(publicPort, "b", 1500);
  check("两个端口都释放了", !aAfter.ok && !bAfter.ok);
  check(
    "pid 与 lock 文件清干净",
    !fs.existsSync(path.join(project.runtimeDir, "server.pid")) &&
      !fs.existsSync(path.join(project.runtimeDir, "start.lock")),
  );
  check(
    "失败/退出过程不碰用户的 .env.local",
    fs
      .readFileSync(path.join(project.root, ".env.local"), "utf8")
      .includes("e2e-sentinel-key"),
  );

  try {
    child.kill("SIGTERM");
  } catch {
    /* 已经走了 */
  }

  console.log("\n== 2/5 失败路径：8787 被别的程序占着 ==");
  const occupiedProject = makeProject();
  tempRoots.push(occupiedProject.root);
  // 被占的那个端口和 B 要用的端口必须不是一回事，用同一对儿保证互不相同
  const { local: foreignPort, public: occupiedBPort } = await freePortPair();
  const foreign = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("foreign");
  });
  await new Promise((r) => foreign.listen(foreignPort, "127.0.0.1", r));
  // 必须异步：foreign 是本进程里的真 http.Server，spawnSync 会冻住事件循环让它答不上话，
  // 探活一超时就误判成「端口空着」——用例绿了，但它测的已经不是端口冲突了。
  const portRun = await runScriptAsync(
    occupiedProject.root,
    "scripts/start.mjs",
    ["--no-open"],
    {
      ...env,
      LOCAL_PORT: String(foreignPort),
      PUBLIC_PORT: String(occupiedBPort),
    },
  );
  check("退出码是端口占用(4)", portRun.status === EXIT.PORT, portRun.status);
  check(
    "文案里点名端口并且说不替用户 kill",
    String(portRun.stdout + portRun.stderr).includes(String(foreignPort)) &&
      // 档3 第 7 条要的是「报进程名」：光给一个 PID 对 A 没有意义（他不知道那是什么程序）
      /被「.+」（进程号/.test(String(portRun.stdout + portRun.stderr)) &&
      /不会替你 kill|不替你 kill/.test(String(portRun.stdout + portRun.stderr)),
    String(portRun.stdout + portRun.stderr).trim().split("\n").slice(-2).join(" / "),
  );
  const stillUp = await fetch(`http://127.0.0.1:${foreignPort}/`)
    .then((r) => r.status)
    .catch(() => 0);
  check("那个陌生服务还活着（我们没杀它）", stillUp === 200, stillUp);
  await new Promise((r) => foreign.close(r));
  check(
    "端口冲突时没写 pid 文件",
    !fs.existsSync(path.join(occupiedProject.runtimeDir, "server.pid")),
  );

  console.log("\n== 3/5 失败路径：构建产物缺失 ==");
  const noDist = makeProject({ dist: false });
  tempRoots.push(noDist.root);
  const noPorts = { LOCAL_PORT: String(localPort), PUBLIC_PORT: String(publicPort) };
  const buildRun = runScript(noDist.root, "scripts/start.mjs", ["--no-open"], {
    ...env,
    ...noPorts,
  });
  check("退出码是构建缺失(6)", buildRun.status === EXIT.BUILD, buildRun.status);
  const buildText = String(buildRun.stdout + buildRun.stderr);
  check("文案指向 prepare-deps", buildText.includes("prepare-deps"), buildText.trim().split("\n").slice(-2).join(" / "));
  check(
    "失败路径没动 .env.local 也没建 sqlite",
    fs.readFileSync(path.join(noDist.root, ".env.local"), "utf8").includes("e2e-sentinel-key") &&
      !fs.existsSync(path.join(noDist.codingDir, "data")),
  );

  console.log("\n== 4/5 失败路径：项目专用 Node 文件在但跑不起来 ==");
  const broken = makeProject({ brokenNode: true });
  tempRoots.push(broken.root);
  const brokenPair = await freePortPair();
  const brokenPorts = {
    LOCAL_PORT: String(brokenPair.local),
    PUBLIC_PORT: String(brokenPair.public),
  };
  // 判定层必须把「跑不起来」和「没装」分开说：前者会误导用户去重装、后者要去下载。
  const reportRun = runScript(broken.root, "scripts/verify-runtime.mjs", ["--json"], {
    ...env,
    ...brokenPorts,
  });
  let report = {};
  try {
    report = JSON.parse(reportRun.stdout);
  } catch {
    /* 下面按空报告断言，会红 */
  }
  check(
    "自检退出码 3（需要修）",
    reportRun.status === EXIT.ENV,
    `${reportRun.status} ${reportRun.stdout.trim().slice(0, 60)}`,
  );
  check(
    "reason 是 SPAWN_FAILED 而不是 MISSING",
    report?.node?.installed === false && report?.node?.reason === "SPAWN_FAILED",
    report?.node?.reason,
  );
  const brokenStart = runScript(broken.root, "scripts/start.mjs", ["--no-open"], {
    ...env,
    ...brokenPorts,
    AIWINDOW_HEALTH_TIMEOUT_MS: "4000",
  });
  check(
    "带病启动不会假装成功（不是 0，也不写 pid）",
    brokenStart.status !== EXIT.OK &&
      !fs.existsSync(path.join(broken.runtimeDir, "server.pid")),
    `${brokenStart.status} ${String(brokenStart.stdout + brokenStart.stderr).trim().split("\n").slice(-1)[0]}`,
  );

  check(
    "全程没碰开发者真项目的 pid 文件",
    (fs.existsSync(realPid) ? fs.readFileSync(realPid, "utf8") : null) === beforeRealPid,
  );

  console.log("\n== 5/5 关掉启动窗口（SIGHUP）也必须是干净收摊 ==");
  // A 的正常退出方式就是「把那个终端窗口关掉」，PRD §12.2 第 19 步把它等同于停止服务。
  // macOS 关窗口发的是 SIGHUP；启动器原先只接 SIGINT/SIGTERM，于是窗口是关了、服务也没了，
  // 但 server.pid / start.lock 会留在 .runtime 里 —— 这里把它钉住，别让下次重构又退回原点。
  const win = makeProject();
  tempRoots.push(win.root);
  const { local: winLocal, public: winPublic } = await freePortPair();
  const winChild = spawnScript(win.root, "scripts/bootstrap.mjs", ["--no-open"], {
    ...env,
    LOCAL_PORT: String(winLocal),
    PUBLIC_PORT: String(winPublic),
  });
  let winOut = "";
  winChild.stdout.on("data", (c) => (winOut += c.toString()));
  winChild.stderr.on("data", (c) => (winOut += c.toString()));
  const winUp = await probeHealth(winLocal, "a", 60_000);
  check("第二个临时项目也起来了", winUp.ok);
  winChild.kill("SIGHUP");
  let winExit = null;
  winChild.on("exit", (code) => (winExit = code));
  for (let i = 0; i < 40 && winExit === null; i++) await sleep(250);
  check("启动器随窗口退出（自己走掉的，不是被强杀）", winExit !== null, `exit=${winExit}`);
  await sleep(600);
  const winA = await probeHealth(winLocal, "a", 1500);
  const winB = await probeHealth(winPublic, "b", 1500);
  check("窗口关掉后两个端口都空了", !winA.ok && !winB.ok);
  check(
    "窗口关掉后 pid / lock 不残留",
    !fs.existsSync(path.join(win.runtimeDir, "server.pid")) &&
      !fs.existsSync(path.join(win.runtimeDir, "start.lock")),
  );
  check(
    "收摊过程说的是人话（没有崩溃字样）",
    /收到 SIGHUP/.test(winOut) && !/被 SIGHUP 结束/.test(winOut),
    winOut.trim().split("\n").slice(-1)[0],
  );
  try {
    winChild.kill("SIGKILL");
  } catch {
    /* 已经走了 */
  }

  console.log(`\n${failures.length ? "❌" : "✅"} 档2 启动脚本端到端：${failures.length === 0 ? "全绿" : `${failures.length} 项失败`}`);
  if (failures.length) for (const f of failures) console.log(`   · ${f}`);
  return failures.length ? 1 : 0;
}

main()
  .then((code) => {
    cleanup();
    process.exitCode = code;
  })
  .catch((err) => {
    console.error("❌ 端到端脚本自身炸了：", err);
    cleanup();
    process.exitCode = 1;
  });

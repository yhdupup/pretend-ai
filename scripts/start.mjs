#!/usr/bin/env node
// 起服务：实例检查 → 端口检查 → 一次性令牌 → 拉起 A/B 两个入口 → 健康检查 → 打开工作台（PRD §6.1 §12.2 §12.3）。
//
// 令牌怎么交给服务端（这一步最容易做错，写清楚）：
// - 令牌由本脚本用 crypto.randomBytes 生成，只经**子进程环境变量**交给服务端；
//   不写文件、不打印、不进 argv、不进日志。服务端在生产模式下只有同时看到
//   AIWINDOW_LAUNCHER_TOKEN=1 且两个键都来自 shell 环境（不是 .env 文件）才会用它，
//   见 coding/src/server/security/control-token.ts。
// - 浏览器那一次导航必须带令牌（这是设计里唯一的暴露点）：不把 URL 放进 argv，
//   而是写一个 0600 的临时 .webloc/.url 文件让系统去开，开完立刻删。
//   这样别的进程 ps 一下看不到令牌，文件也只对本用户可读。
//
// 前台常驻：脚本进程跟着服务进程一起活着，关掉终端窗口 = 正常停止（会走服务端的优雅退出流程，
// 结束所有会话、收掉隧道子进程）。不做后台守护、不装 launchd/服务（开发文档 §5.6）。
//
// 用法：node scripts/start.mjs [--no-open] [--keep-logs]
// 退出码：0 正常退出 / 4 端口被占用 / 5 已有实例在跑 / 6 构建产物缺失 / 3 其它环境问题

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  CODING_DIR,
  platformTarget,
  EXIT,
  LOCK_FILE,
  LOG_DIR,
  PID_FILE,
  REPO_ROOT,
  RUNTIME_DIR,
  detail,
  die,
  isMain,
  loadManifest,
  nodeBinDir,
  nodeExecutable,
  resolvePort,
  step,
} from "./lib.mjs";
import { checkBuild } from "./verify-runtime.mjs";

export const SERVER_ENTRY = path.join(CODING_DIR, "dist", "server", "index.js");

export function newControlToken() {
  return crypto.randomBytes(32).toString("hex");
}

/** 读一个 URL，返回状态码；连不上返回 null。用来区分「端口空着」与「别人在用」。 */
export function probeUrl(url, { timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs, agent: false }, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0 });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
  });
}

/** TCP 能不能连上（不问它是什么服务）。 */
export function portOpen(port, host = "127.0.0.1", timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.get(
      { host, port, path: "/", timeout: timeoutMs, agent: false },
      (res) => {
        res.resume();
        resolve(true);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(true);
    });
    req.on("error", (err) => resolve(err.code === "ECONNREFUSED" ? false : true));
  });
}

export function readPidFile(file = PID_FILE) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Number.isFinite(raw?.pid)) return null;
    return raw;
  } catch {
    return null;
  }
}

export function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 一次探活用的随机串（只含健康端点白名单接受的字符）。 */
export function newProbe() {
  return crypto.randomBytes(9).toString("hex");
}

/**
 * 「8787 上是不是本项目、是不是我们期望的那一次启动」的判据：
 * 带一个随机 probe 去问健康端点，回显对得上才算 ours。
 * 只看状态码会被三种情况骗过：别人的服务也回 200、代理/缓存喂回旧响应、旧版本实例跑在同一个端口。
 */
export async function detectLocalInstance(
  ports,
  { probe = newProbe() } = {},
) {
  const health = await probeJson(
    `http://127.0.0.1:${ports.local}/api/local/health?probe=${probe}`,
  );
  if (!health) return { kind: "free" };
  if (health.status === 200 && health.body?.service === "a" && health.body?.probe === probe) {
    return { kind: "ours", body: health.body };
  }
  // 200 但回显不对 = 有东西在答话但不是我们要的那个（缓存 / 旧版本 / 别人的实现）。
  return { kind: "foreign", status: health.status, body: health.body };
}

/** 读一个 JSON 响应；连不上返回 null，连上了但答话的不是本项目返回 foreign。 */
export async function detectPublicInstance(
  ports,
  { probe = newProbe() } = {},
) {
  const health = await probeJson(
    `http://127.0.0.1:${ports.public}/api/public/health?probe=${probe}`,
  );
  if (!health) return { kind: "free" };
  if (
    health.status === 200 &&
    health.body?.service === "b" &&
    health.body?.probe === probe
  )
    return { kind: "ours", body: health.body };
  return { kind: "foreign", status: health.status, body: health.body };
}

/** 读一个 URL 并尝试把响应体当 JSON 解析（超时/连不上返回 null）。 */
export function probeJson(url, { timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body = null;
        try {
          body = JSON.parse(text);
        } catch {
          body = null; // 不是 JSON 就是「别人在答话」，交给调用方判 foreign
        }
        resolve({ status: res.statusCode ?? 0, body, text });
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
  });
}

/**
 * 谁占着这个端口（开发文档 §5.6 第 3 分支：要打印进程名与 PID，绝不自动 kill）。
 * macOS/Linux 用 lsof，Windows 用 Get-NetTCPConnection + Get-Process；拿不到就回 null，
 * 文案退化成「只报端口号」，不能因为查不到主人就拒绝报错。
 */
export function portOwner(
  port,
  { platform = process.platform } = {},
) {
  try {
    if (platform === "win32") {
      const out = spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `$c=Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue|Select-Object -First 1;` +
            `if($c){$p=Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue;"$($c.OwningProcess)|$($p.ProcessName)"}`,
        ],
        { encoding: "utf8", timeout: 8_000 },
      );
      const [pid, name] = String(out.stdout ?? "").trim().split("|");
      return pid ? { pid, name: name || null } : null;
    }
    // -F 的字段字母要写对：n 是网络地址、c 才是命令名。原先只请求了 pn，
    // 下面却去找 "c" 开头的行，于是 macOS 上永远拿不到进程名，档3 第 7 条要求的
    // 「报进程名」实际输出成了「只报进程号」。
    const out = spawnSync("lsof", ["-nP", "-iTCP:" + port, "-sTCP:LISTEN", "-Fpc"], {
      encoding: "utf8",
      timeout: 8_000,
    });
    const lines = String(out.stdout ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const pid = lines.find((l) => l.startsWith("p"))?.slice(1);
    const name = lines.find((l) => l.startsWith("c"))?.slice(1);
    return pid ? { pid, name: name ?? null } : null;
  } catch {
    return null;
  }
}

/** 占用端口的中文描述：「被「Google Chrome」(PID 1234) 占用」。查不到就只报端口。 */
export function ownerText(owner) {
  if (!owner) return "被别的程序占着";
  if (owner.name) return `被「${owner.name}」（进程号 ${owner.pid}）占着`;
  return `被进程号 ${owner.pid} 占着`;
}

/**
 * 启动前自检（开发文档 §5.4）。
 *
 * 为什么不能省：服务端对 skills.json 是「读不到就降级走内置模板」（阶段二实现记录②），
 * 目录摆错位置时它**不会报错**，只会让两个 Skill 静默失效 —— 对 A 来说就是「AI 变笨了」，
 * 但看不出原因。所以脚本层先把这些「读不到不报错、但功能缺了一半」的东西检查完。
 * 只查存在性与可读性，不查内容合法性（那是 vitest 的活）。
 */
export function preflightCheck({ root = REPO_ROOT } = {}) {
  const problems = [];
  const need = [
    // [路径, 说人话的名字]
    [path.join(root, "coding", "package.json"), "coding/package.json（程序本体）"],
    [path.join(root, "coding", "node_modules"), "coding/node_modules（第三方依赖）"],
    [path.join(root, "config", "skills.json"), "config/skills.json（两个 Skill 的路径声明）"],
    [path.join(root, ".env.example"), ".env.example（默认参数模板）"],
    [path.join(root, "runtime-manifest.json"), "runtime-manifest.json（项目专用运行时清单）"],
  ];
  for (const [file, name] of need) {
    if (!fs.existsSync(file)) problems.push(`找不到 ${name}`);
  }
  // 两个 Skill 目录的相对路径写在 config/skills.json 里，以项目根为基准解析；
  // 目录改名/搬走不会让服务报错，只会让两个 Skill 静默空转，所以这里要提前说。
  const skillsPath = path.join(root, "config", "skills.json");
  if (fs.existsSync(skillsPath)) {
    try {
      const skills = JSON.parse(fs.readFileSync(skillsPath, "utf8"));
      for (const key of ["aiStyleSkillPath", "analysisSkillPath"]) {
        const dir = skills?.[key];
        if (typeof dir !== "string" || !dir.trim()) {
          problems.push(`config/skills.json 里 ${key} 没填`);
          continue;
        }
        if (path.isAbsolute(dir)) {
          problems.push(`config/skills.json 里 ${key} 必须是项目内相对路径，不能写绝对路径`);
          continue;
        }
        if (!fs.existsSync(path.join(root, dir))) {
          problems.push(
            `Skill 目录「${dir}」读不到，${key === "aiStyleSkillPath" ? "增加 AI 味" : "深度思考反推"}会降级成人工回复`,
          );
        }
      }
    } catch (err) {
      // 不回传解析器原文：它会带上绝对路径（PRD §18.6）。
      problems.push("config/skills.json 不是合法 JSON");
    }
  }
  return { ok: problems.length === 0, problems };
}

/** 锁文件：防「双击两次」在端口检查还没跑完之前并发跑两份完整启动流程。 */
export function acquireLock(file = LOCK_FILE, staleMs = 10 * 60_000) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const st = fs.statSync(file);
    const holder = (() => {
      try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        return null;
      }
    })();
    if (holder?.pid && pidAlive(holder.pid) && Date.now() - st.mtimeMs < staleMs) {
      return { acquired: false, reason: "LOCK_HELD", holder };
    }
    // 上一次是崩溃留下的：谁都没在跑，就抢过来。宁可多删一个陈旧锁文件，
    // 也不能让 A 永远卡在「另一个安装正在准备环境」。
    fs.rmSync(file, { force: true });
  } catch {
    /* 没有锁文件，往下创建 */
  }
  try {
    const fd = fs.openSync(file, "wx");
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    fs.closeSync(fd);
    return { acquired: true, file };
  } catch (err) {
    if (err.code === "EEXIST") return { acquired: false, reason: "LOCK_RACE" };
    throw err;
  }
}

export function releaseLock(file = LOCK_FILE) {
  try {
    const holder = JSON.parse(fs.readFileSync(file, "utf8"));
    if (holder?.pid === process.pid) fs.rmSync(file, { force: true });
  } catch {
    /* 已经不在了 */
  }
}

/** 把一次性引导地址交给默认浏览器，不让它出现在任何进程的 argv 里。 */
export function openInBrowser(url, { platform = process.platform, tmpDir = os.tmpdir() } = {}) {
  const file = path.join(tmpDir, `aiwindow-open-${process.pid}.${platform === "win32" ? "url" : "webloc"}`);
  try {
    const content =
      platform === "win32"
        ? `[InternetShortcut]\r\nURL=${url}\r\n`
        : `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n\t<key>URL</key>\n\t<string>${url}</string>\n</dict>\n</plist>\n`;
    fs.writeFileSync(file, content, { mode: 0o600 });
    const cmd =
      platform === "win32" ? "cmd" : platform === "darwin" ? "open" : "xdg-open";
    const args =
      platform === "win32" ? ["/c", "start", "", file] : [file];
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      /* 打不开就算了：下面会把地址打出来让用户自己粘 */
    });
    child.unref();
    // 令牌在文件里待着的时间越短越好；浏览器读完就会复制到自己的历史里（那是用户自己的机器）。
    setTimeout(() => fs.rmSync(file, { force: true }), 5_000).unref?.();
    return { ok: true, file };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

export function startLogfile(keep = true, logDir = LOG_DIR, { retain = 5 } = {}) {
  fs.mkdirSync(logDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(logDir, `run-${stamp}.log`);
  const names = fs
    .readdirSync(logDir)
    .filter((name) => /^run-.*\.log$/.test(name) && name !== path.basename(file))
    .sort(); // 文件名里的时间戳是 ISO 形式，字典序就是时间序
  if (!keep) {
    // --fresh-logs：档2 的端到端脚本靠它保证「本次看到的日志一定是本次写的」。
    for (const name of names) fs.rmSync(path.join(logDir, name), { force: true });
  } else {
    // 只按文件名删自己写的东西（开发文档 §5.10）：连新写的这份一起，最多 retain 份。
    for (const name of names.slice(0, Math.max(0, names.length - (retain - 1))))
      fs.rmSync(path.join(logDir, name), { force: true });
  }
  // 先把空文件建出来：万一 spawn 之前就炸了，用户手里至少有个能打开的东西。
  // 日志里可能出现本机路径与报错，权限收到 0600。
  const fd = fs.openSync(file, "a");
  fs.closeSync(fd);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows 上没有 POSIX 位，忽略 */
  }
  return file;
}

/**
 * 启动主流程。全部依赖注入到 options 里，单测可以只换 spawn / probe。
 */
export async function start(options = {}) {
  const env = options.env ?? process.env;
  const ports = options.ports ?? {
    local: resolvePort("LOCAL_PORT", 8787),
    public: resolvePort("PUBLIC_PORT", 8788),
  };
  const log = options.log ?? ((state, extra) => step(state, extra));
  const manifest = options.manifest ?? loadManifest();
  const target = options.target ?? platformTarget();
  const exe = options.nodeExe ?? nodeExecutable(target, manifest);
  const doOpen = options.open !== false;
  // 真开浏览器要注入掉才能跑单测（否则测试会把 A 的浏览器弹出来）。
  const openBrowser = options.openBrowser ?? openInBrowser;
  const token = options.token ?? newControlToken();
  const pidFile = options.pidFile ?? PID_FILE;
  const lockFile = options.lockFile ?? LOCK_FILE;
  const logDir = options.logDir ?? LOG_DIR;

  // 1) 已有实例 / 我们的锁
  const recorded = readPidFile(pidFile);
  if (recorded && pidAlive(recorded.pid)) {
    return {
      code: EXIT.ALREADY_RUNNING,
      message: `这个项目的本地服务已经在跑了（PID ${recorded.pid}）。`,
      hint: `直接刷新浏览器里的 A 工作台就行；要重启就先跑 stop 脚本，或者关掉原来那个终端窗口。`,
    };
  }
  if (recorded && !pidAlive(recorded.pid)) {
    // 上次没干净退出留下的 pid 文件。数据侧有「启动即清场」兜着，这里只负责把它删掉。
    fs.rmSync(pidFile, { force: true });
  }

  const lock = options.lock ?? acquireLock(lockFile);
  if (lock.acquired === false) {
    return {
      code: EXIT.ALREADY_RUNNING,
      message: "另一个启动过程正在准备环境。",
      hint: "等它跑完（首次会装依赖和构建，几分钟）。确认没有卡在别的机器上就删掉 .runtime/start.lock。",
    };
  }

  try {
    // 2) 端口：空 / 本项目在跑 / 别人占着，三种结果三种行为（PRD §12.2 第 11、12 条）。
    const detected = await detectLocalInstance(ports);
    if (detected.kind === "ours") {
      // 不试图接管、不猜它的令牌：那是上一次启动的一次性值（开发文档 §5.6）。
      if (doOpen) openBrowser(`http://127.0.0.1:${ports.local}/`);
      return {
        code: EXIT.ALREADY_RUNNING,
        message: `工作台已经在运行：http://127.0.0.1:${ports.local}`,
        hint: "已重新打开浏览器。要重启就先跑 stop，或者关掉原来那个终端窗口。",
      };
    }
    if (detected.kind === "foreign") {
      const owner = portOwner(ports.local);
      return {
        code: EXIT.PORT,
        message: `${ports.local} 端口${ownerText(owner)}，它不是本项目的服务。`,
        hint: `退出那个程序后重试（我们不会替你 kill 它）；或者在 .env.example 里把 LOCAL_PORT 改成别的值（同步改 PUBLIC_PORT）。`,
      };
    }
    const publicDetected = await detectPublicInstance(ports);
    if (publicDetected.kind !== "free") {
      const owner = portOwner(ports.public);
      return {
        code: EXIT.PORT,
        message: `${ports.public} 端口${ownerText(owner)}（B 入口要用它）。`,
        hint: "退出那个程序后重试（我们不会替你 kill 它）；或改 .env.example 里的 PUBLIC_PORT（改完 B 链接会自动跟上）。",
      };
    }

    // 2b) 启动前自检（开发文档 §5.4）：目录不对就带着错跑，Skill 会全瞎。
    const preflight = options.preflight ?? preflightCheck;
    const check = preflight({ root: options.root ?? REPO_ROOT });
    if (!check.ok) {
      return {
        code: EXIT.ENV,
        message: `启动前自检没通过：${check.problems.join("；")}`,
        hint: "本项目必须整体放在一个目录里，启动脚本要从项目根目录跑（coding/ 的上一层）。",
      };
    }

    // 3) 产物齐不齐（齐不齐全靠 prepare-deps，这里只兜底确认）
    const build = options.build ?? checkBuild();
    if (!build.ok) {
      return {
        code: EXIT.BUILD,
        message: `构建产物不全：${JSON.stringify(build)}`,
        hint: "跑 node scripts/prepare-deps.mjs 看具体报错。",
      };
    }

    // 3b) 信号处理必须在「拉起服务之前」装好。
    // A 在「正在准备…」阶段关掉窗口的概率非常高（第一次下载 Node 要一两分钟），
    // 而 macOS 关窗口发的 SIGHUP 默认行为是让启动器立刻死掉：服务进程变成没人管的孤儿，
    // 端口还听着、pid / lock 还留着，屏幕上却什么都没了 —— PRD §12.2 第 19 步最不想
    // 看到的就是这种「以为停了其实没停」。档2 第 5 组实测复现过一次。
    let serverChild = null;
    let stopping = false;
    let relayed = false;
    const relay = (signal) => {
      if (stopping) return;
      stopping = true;
      relayed = true;
      log("STOPPING", `收到 ${signal}，正在停止`);
      if (!serverChild) return; // 还没起服务：锁由 finally 放，pid 文件还没写，不用清
      try {
        serverChild.kill("SIGTERM");
      } catch {
        /* 它已经先走了 */
      }
    };
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      process.on(sig, () => relay(sig));
    }

    // 4) 拉起来。日志进 logs/run-*.log：终端只留人话，出问题时 A 能把文件发回来。
    if (stopping) {
      // 信号在前面的 await 期间就到了：别再往上起了，直接算「你把它停了」。
      return { code: EXIT.OK, message: "启动已经按你的操作中断。", hint: "想接着用，重新双击启动就行。" };
    }
    const logFile =
      options.logFile ?? startLogfile(options.keepLogs !== false, logDir);
    const fd = fs.openSync(logFile, "a");
    log("STARTING_CORE", `日志写在 ${path.relative(REPO_ROOT, logFile)}`);
    const spawnImpl = options.spawn ?? spawn;
    const child = spawnImpl(
      exe,
      [SERVER_ENTRY],
      {
        cwd: CODING_DIR,
        env: {
          ...env,
          // 脚本起的这一份就是「正式跑」的形态：生产模式日志只留 info+，不含草稿与提示词。
          NODE_ENV: env.NODE_ENV ?? "production",
          LOCAL_CONTROL_TOKEN_SECRET: token,
          AIWINDOW_LAUNCHER_TOKEN: "1",
          PATH: `${nodeBinDir(target, manifest)}${path.delimiter}${env.PATH ?? ""}`,
        },
        stdio: ["ignore", fd, fd],
        detached: false,
      },
    );
    serverChild = child;
    child.on("error", (err) => {
      process.stderr.write(`服务进程起不来：${err.message}\n`);
    });

    // 5) 两个端口都要探到（PRD §12.2 第 15 步）
    // 健康检查超时：默认 30 秒（首次冷启动 + 建库要时间）。
  // AIWINDOW_HEALTH_TIMEOUT_MS 只给测试与排查用（开发文档 §5.13），线上不填就是默认值。
  const healthTimeoutMs =
    options.healthTimeoutMs ?? (Number(env.AIWINDOW_HEALTH_TIMEOUT_MS) || 30_000);
  const deadline = Date.now() + healthTimeoutMs;
    const waitHealth = options.waitHealth ?? waitHealthy;
    const ready = await waitHealth(ports, deadline, { shouldAbort: () => stopping });
    if (stopping && !ready.ok) {
      // 是 A 自己关窗口/按 Ctrl+C 停的，不是故障，别报成「健康检查没过」。
      fs.closeSync(fd);
      return {
        code: EXIT.OK,
        message: "启动已经按你的操作中断，服务没有留下来。",
        hint: "想接着用，重新双击启动就行。",
      };
    }
    if (!ready.ok) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* 已经死了 */
      }
      fs.closeSync(fd);
      return {
        code: EXIT.ENV,
        message: `本地服务起来了但健康检查没过（${ready.reason}）。`,
        hint: `看 ${path.relative(REPO_ROOT, logFile)} 的最后几十行；常见原因是端口或数据目录权限。`,
      };
    }
    fs.closeSync(fd);

    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(
      pidFile,
      JSON.stringify(
        {
          pid: child.pid,
          nodeExe: exe,
          // 记下我们认得的东西，stop 时才能确认「这个 PID 还是我起的那个服务」而不是别人的 PID。
          startedAt: Date.now(),
          ports,
          entry: SERVER_ENTRY,
        },
        null,
        2,
      ),
    );

    const bootstrapUrl = `http://127.0.0.1:${ports.local}/api/local/bootstrap/${token}`;
    log("OPENING_BROWSER");
    if (doOpen) {
      const opened = openBrowser(bootstrapUrl);
      if (!opened.ok) {
        detail(`自动打开失败（${opened.reason}），请手工访问下面这个一次性地址`);
        process.stdout.write(`    ${bootstrapUrl}\n`);
      }
    } else {
      process.stdout.write(`    一次性引导地址：${bootstrapUrl}\n`);
    }
    log(
      "READY",
      `就绪。A 工作台：http://127.0.0.1:${ports.local}（这个窗口请保持开着，关掉就等于退出）`,
    );

    const result = { code: EXIT.OK, child, pid: child.pid, logFile, token };
    if (options.foreground === false) return result;

    // 6) 前台等：Ctrl+C / 关窗口都转成给服务端的 SIGTERM，等它把会话和隧道收干净
    return await new Promise((resolve) => {
      let closing = false;
      const finish = (code) => {
        if (closing) return;
        closing = true;
        cleanup();
        resolve({ ...result, code });
      };
      const cleanup = () => {
        fs.rmSync(pidFile, { force: true });
        releaseLock(lockFile);
      };
      // 信号在 §3b 就接好了（早于服务进程存在的那一刻）；这里只负责等它退出后清场。
      if (stopping) relayed = true; // 已经在 READY 之前收到过信号了
      child.on("exit", (code, signal) => {
        // 我们自己喊停的（关窗口 / Ctrl+C / stop 脚本）就别再吓 A：
        // 那句「服务进程被 X 结束（退出码 null）」看着像崩溃，其实就是正常收摊。
        if (signal && !relayed) {
          process.stderr.write(`服务进程被 ${signal} 结束（退出码 ${code}）\n`);
        }
        finish(0);
      });
      result.cleanup = cleanup;
    });
  } finally {
    if (options.lock === undefined) releaseLock(lockFile);
  }
}

/** 轮询两个入口，直到都带着我们要求的 probe 回显答话，或者超时。 */
export async function waitHealthy(
  ports,
  deadline,
  { intervalMs = 250, probe = newProbe(), shouldAbort = null } = {},
) {
  let last = null;
  while (Date.now() < deadline) {
    if (shouldAbort?.()) return { ok: false, reason: "ABORTED_BY_USER" };
    const a = await probeJson(
      `http://127.0.0.1:${ports.local}/api/local/health?probe=${probe}`,
    );
    const b = await probeJson(
      `http://127.0.0.1:${ports.public}/api/public/health?probe=${probe}`,
    );
    if (
      a?.status === 200 &&
      a.body?.service === "a" &&
      a.body?.probe === probe &&
      b?.status === 200 &&
      b.body?.service === "b" &&
      b.body?.probe === probe
    )
      return { ok: true };
    last = `a=${a?.status ?? "down"} b=${b?.status ?? "down"}`;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { ok: false, reason: `TIMEOUT ${last}` };
}

export function main(argv = process.argv.slice(2)) {
  return start({
    open: !argv.includes("--no-open"),
    keepLogs: !argv.includes("--fresh-logs"),
  }).then((result) => {
    if (result.code !== EXIT.OK) {
      return die(result.code, result.message, result.hint);
    }
    return EXIT.OK;
  });
}

if (isMain(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
    // 这里绝不用 process.exit()：stdout 接的是管道时（`./start-macos.command > 启动.log`、
    // 或 e2e 里那样捕获输出），Node 的写入是异步的，100ms 后强退会把还压在缓冲里的最后几行
    // 丢掉 —— 丢的恰好是「[就绪]」和那串一次性令牌，A 照着日志找地址就永远找不到。
    // 需要吊着事件循环的句柄（浏览器临时文件的延时删除）都已经 unref() 过，让它自然结束。
  });
}

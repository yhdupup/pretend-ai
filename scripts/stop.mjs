#!/usr/bin/env node
// 停服务（PRD §12.2 第 19 步、开发文档 §5.5）。
//
// 三条纪律：
// 1. 只停「我们自己起的那个进程」：pid 文件里记了 PID、启动时间、用的哪个 node、跑的是哪个入口，
//    停之前用系统命令复核一遍。PID 会被操作系统回收复用，光看数字就 kill 是事故来源。
// 2. 优先走优雅退出（SIGTERM）：服务端的 handler 会结束所有会话、收掉隧道子进程、关两个监听
//    （coding/src/server/index.ts 里的 shutdown）。不 -9。
// 3. 复核不到归属就什么都不杀，只告诉用户怎么办。
//
// Windows 差异（写在文档 §5.5 的那条）：Node 在 win32 上 process.kill(pid, "SIGTERM") 等价于
// TerminateProcess，没有优雅退出语义。所以 win32 走「等到超时 → taskkill /T 结束整棵进程树」，
// 并且这是唯一会用到 /F 的分支。
//
// 用法：node scripts/stop.mjs [--timeout 15000]
// 退出码：0 已停 / 5 没有在跑的实例 / 3 认不出归属（不敢杀）

import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import {
  EXIT,
  PID_FILE,
  REPO_ROOT,
  detail,
  die,
  isMain,
  processAlive,
  resolvePort,
  step,
} from "./lib.mjs";
import { SERVER_ENTRY, probeUrl, readPidFile } from "./start.mjs";

/** 复核这个 PID 到底是不是我们起的那个服务。认不出来就返回 false（宁可不杀）。 */
export function verifyOwnership(record, { platform = process.platform } = {}) {
  if (!record?.pid) return { ours: false, reason: "NO_RECORD" };
  if (!record.entry || path.basename(record.entry) !== "index.js")
    return { ours: false, reason: "NO_ENTRY" };
  try {
    if (platform === "win32") {
      const out = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${record.pid}").ExecutablePath`,
        ],
        { encoding: "utf8", timeout: 10_000 },
      ).trim();
      const mine = out && record.nodeExe
        ? path.normalize(out).toLowerCase() === path.normalize(record.nodeExe).toLowerCase()
        : Boolean(out);
      if (!out)
        return { ours: false, gone: !processAlive(record.pid), reason: "PROCESS_GONE" };
      return { ours: mine, actual: out };
    }
    const out = execFileSync("ps", ["-p", String(record.pid), "-o", "args="], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
    // ps 对不存在的 pid 会退非 0（上面走 catch），但有的平台只给空输出：两种都当「没这个进程」。
    if (!out)
      return {
        ours: false,
        gone: !processAlive(record.pid),
        reason: "PROCESS_GONE",
      };
    // 命令行里既要看到我们的 node，也要看到我们的入口文件。
    return { ours: out.includes(path.basename(SERVER_ENTRY)), actual: out };
  } catch (err) {
    // 关键区分：「查不到」有两种含义 —— 进程早没了（可以安全清理 pid 文件），
    // 和进程在、只是不属于我们（绝对不能动）。以前两种都当后者，用户双击停止
    // 一个已经异常退出的实例时，会看到一句「启动失败：我不会去杀它」+ 让他手删隐藏文件。
    return {
      ours: false,
      gone: !processAlive(record.pid),
      reason: `LOOKUP_FAILED ${err.code ?? err.message}`,
    };
  }
}

async function portsFreed(ports) {
  const a = await probeUrl(`http://127.0.0.1:${ports.local}/api/local/health`);
  const b = await probeUrl(`http://127.0.0.1:${ports.public}/api/public/health?probe=basic`);
  return { aDown: !a, bDown: !b };
}
export async function stop(options = {}) {
  const ports = options.ports ?? {
    local: resolvePort("LOCAL_PORT", 8787),
    public: resolvePort("PUBLIC_PORT", 8788),
  };
  const platform = options.platform ?? process.platform;
  const readRecord = options.readPidFile ?? (() => readPidFile(pidFile));
  const kill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
  const pidFile = options.pidFile ?? PID_FILE;
  const lockFile = options.lockFile ?? path.join(path.dirname(PID_FILE), "start.lock");
  const record = readRecord();

  if (!record) {
    const health = await probeUrl(
      `http://127.0.0.1:${ports.local}/api/local/health`,
    );
    if (health?.status === 200) {
      return {
        code: EXIT.ENV,
        message: `端口 ${ports.local} 上有本项目的服务，但找不到 .runtime/server.pid，我不动它。`,
        hint: "它多半是在另一个终端里手工跑起来的：在那个窗口按 Ctrl+C，或直接关掉那个窗口。",
      };
    }
    return {
      code: EXIT.ALREADY_RUNNING,
      message: "没有在跑的实例。",
      hint: "",
    };
  }

  const ownership = (options.verify ?? verifyOwnership)(record, { platform });
  if (!ownership.ours) {
    // 记录里的进程早就不在了：没东西可杀。把残留的 pid / lock 文件清掉，
    // 再用端口实测确认一下，确认干净就当「已经停好了」，而不是丢一句报错给用户。
    if (ownership.gone) {
      fs.rmSync(pidFile, { force: true });
      fs.rmSync(lockFile, { force: true });
      const freed = await portsFreed(ports);
      if (freed.aDown && freed.bDown) {
        step(
          "DONE",
          `上次的进程记录已经失效，帮你清掉了（A ${ports.local} / B ${ports.public} 都是空的）`,
        );
        return { code: EXIT.OK };
      }
      return {
        code: EXIT.PORT,
        message: `上次的进程已经不在了，但端口还被人占着（A ${freed.aDown ? "已空" : "仍占用"} / B ${freed.bDown ? "已空" : "仍占用"}）。`,
        hint: `残留记录已清掉。端口占用多半是另一个程序，改 .env.example 里的 LOCAL_PORT / PUBLIC_PORT 最省事。`,
      };
    }
    return {
      code: EXIT.ENV,
      message: `PID ${record.pid} 已经不是本项目起的那个进程了（${ownership.reason ?? "对不上号"}），我不会去杀它。`,
      hint: `删掉 ${path.relative(REPO_ROOT, pidFile)} 再重新启动即可。`,
    };
  }

  step("STOPPING", `PID ${record.pid}`);
  try {
    kill(record.pid, platform === "win32" ? "SIGTERM" : "SIGTERM");
  } catch (err) {
    if (err?.code !== "ESRCH") throw err;
  }

  const timeoutMs = options.timeoutMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;
  let status = { aDown: false, bDown: false };
  while (Date.now() < deadline) {
    status = await portsFreed(ports);
    if (status.aDown && status.bDown) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  if ((!status.aDown || !status.bDown) && platform === "win32") {
    // 见文件头：win32 没有 SIGTERM 语义，超时之后只能整棵树收掉。
    detail("优雅退出超时，改用 taskkill 结束进程树");
    spawnSync("taskkill", ["/PID", String(record.pid), "/T", "/F"], {
      stdio: "ignore",
      timeout: 10_000,
    });
    await new Promise((r) => setTimeout(r, 500));
    status = await portsFreed(ports);
  }

  fs.rmSync(pidFile, { force: true });
  fs.rmSync(lockFile, { force: true });

  if (!status.aDown || !status.bDown) {
    return {
      code: EXIT.ENV,
      message: `进程已结束，但端口还没空出来（A ${status.aDown ? "已空" : "仍占用"} / B ${status.bDown ? "已空" : "仍占用"}）。`,
      hint: "等 1~2 秒再试；一直不空就是别的程序占了这两个端口，改 .env.example 里的端口最省事。",
    };
  }
  step("DONE", `已停止（A ${ports.local} / B ${ports.public} 都空出来了）`);
  return { code: EXIT.OK };
}

export async function main(argv = process.argv.slice(2)) {
  const timeout = Number(argv[argv.indexOf("--timeout") + 1]) || undefined;
  const result = await stop({ timeoutMs: timeout });
  if (result.code !== EXIT.OK)
    return die(result.code, result.message, result.hint, "停止失败");
  return EXIT.OK;
}

if (isMain(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}

#!/usr/bin/env node
// 依赖安装与构建（PRD §12.2 第 8~13 步）。
//
// 关键设计：不是「每次启动都 npm ci + build」，而是拿指纹决定要不要动。
//   deps 戳：package.json / package-lock.json 内容 + 当时用的 Node 版本；
//   build 戳：src 与两个前端 src 等内容哈希。
// 换 Node 版本一定会重装（原生模块 better-sqlite3 是按 ABI 编译的，不重装会起不来）。
//
// 退出码：0 就绪 / 6 安装或构建失败（把子进程的输出原样留给终端，不吞错误）

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  CODING_DIR,
  EXIT,
  REPO_ROOT,
  detail,
  die,
  isMain,
  nodeBinDir,
  platformTarget,
  step,
  writeStamp,
} from "./lib.mjs";
import {
  depsKey,
  probe,
  sourceKey,
} from "./verify-runtime.mjs";

/** 给子进程准备好 PATH：项目 Node 的 bin 目录排在最前面。 */
export function childEnv(env = process.env, binDir) {
  const sep = process.platform === "win32" ? ";" : ":";
  const parts = [binDir, env.PATH ?? ""].filter(Boolean);
  // 去重：重复的 PATH 段落会让「到底用了哪个 npm」变得难以判断。
  const seen = new Set();
  const deduped = parts.filter((p) => {
    const key = p.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { ...env, PATH: deduped.join(sep) };
}

export function npmInvocation(cmd, args, { offline } = {}) {
  // Windows 上 npm 是 npm.cmd，用 shell:false 直接指定可执行文件最稳。
  const bin = process.platform === "win32" ? "npm.cmd" : "npm";
  const extra = offline ? ["--offline"] : [];
  return { bin, args: [cmd, ...extra, ...args] };
}

function run(cmd, args, { cwd, env }) {
  const result = spawnSync(cmd, args, {
    cwd,
    env,
    stdio: "inherit",
    // npm ci 在慢网下装原生模块可能十几分钟；给 30 分钟上限，超时算失败。
    timeout: 30 * 60_000,
  });
  if (result.error) {
    const err = new Error(`SPAWN_FAILED ${result.error.message}`);
    err.code = "SPAWN_FAILED";
    throw err;
  }
  if (result.status !== 0) {
    const err = new Error(`COMMAND_FAILED ${cmd} ${args.join(" ")} exit=${result.status}`);
    err.code = "COMMAND_FAILED";
    err.status = result.status;
    throw err;
  }
  return result;
}

/** 装依赖（npm ci 优先，没 lockfile 才退到 npm install）。 */
export function ensureDeps(options = {}) {
  const root = options.root ?? REPO_ROOT;
  const codingDir = options.codingDir ?? CODING_DIR;
  const runtimeDir =
    options.runtimeDir ?? path.join(root, ".runtime");
  const target = options.target ?? platformTarget();
  const binDir = options.binDir ?? nodeBinDir(target, options.manifest ?? null, root);
  const manifest = options.manifest ?? null;
  const report = options.report ?? probe({ root, codingDir, runtimeDir, target });
  const env = childEnv(options.env ?? process.env, binDir);

  if (report.deps.installed && !options.force) {
    return { action: "skip", reason: report.deps.reason };
  }
  step("CHECKING_DEPS", `首次或依赖有变化，安装中（可能需要几分钟）`);
  const lockfile = fs.existsSync(path.join(codingDir, "package-lock.json"));
  const invocation = lockfile
    ? npmInvocation("ci", ["--no-audit", "--no-fund"])
    : npmInvocation("install", ["--no-audit", "--no-fund"]);
  run(invocation.bin, invocation.args, { cwd: codingDir, env });
  writeStamp(
    "deps",
    {
      depsKey: depsKey(codingDir),
      nodeVersion: manifest?.nodeTag ?? report.manifest.nodeVersion,
      // 换机器 / 换架构要靠这两个字段识别出来（原生模块不是跨平台的）。
      platform: process.platform,
      arch: process.arch,
    },
    runtimeDir,
  );
  return { action: "installed" };
}

/** 构建：服务端 tsc + 两个前端 vite build（就是 npm run build）。 */
export function ensureBuild(options = {}) {
  const root = options.root ?? REPO_ROOT;
  const codingDir = options.codingDir ?? CODING_DIR;
  const runtimeDir = options.runtimeDir ?? path.join(root, ".runtime");
  const target = options.target ?? platformTarget();
  const binDir = options.binDir ?? nodeBinDir(target, options.manifest ?? null, root);
  const report = options.report ?? probe({ root, codingDir, runtimeDir, target });
  const env = childEnv(options.env ?? process.env, binDir);

  if (!report.build.stale && !options.force) {
    return { action: "skip" };
  }
  step("BUILDING", "构建服务端与两个界面（首次约 1~2 分钟）");
  const invocation = npmInvocation("run", ["build"]);
  run(invocation.bin, invocation.args, { cwd: codingDir, env });
  writeStamp(
    "build",
    { sourceKey: sourceKey(codingDir) },
    runtimeDir,
  );
  const after = probe({ root, codingDir, runtimeDir, target });
  if (!after.build.present) {
    const err = new Error(`BUILD_INCOMPLETE ${JSON.stringify(after.build.parts)}`);
    err.code = "BUILD_INCOMPLETE";
    throw err;
  }
  detail("构建产物齐了：dist/server + 两个前端 dist");
  return { action: "built" };
}

export function main(argv = process.argv.slice(2)) {
  const root = REPO_ROOT;
  try {
    const report = probe({ root });
    if (!report.node.installed) {
      return die(
        EXIT.ENV,
        `项目专用 Node 还没准备好（${report.node.reason}）。`,
        "先跑 node scripts/node-bootstrap.mjs，或直接用 start-macos.command / start-windows.bat。",
      );
    }
    const binDir = nodeBinDir(report.target, null, root);
    const deps = ensureDeps({ root, report, binDir, manifest: { nodeTag: report.manifest.nodeVersion }, force: argv.includes("--force-deps") });
    detail(deps.action === "skip" ? "依赖已是最新，跳过安装" : "依赖安装完成");
    const build = ensureBuild({ root, report, binDir, force: argv.includes("--force-build") });
    detail(build.action === "skip" ? "构建产物是最新内容，跳过构建" : "构建完成");
    return EXIT.OK;
  } catch (err) {
    if (err.code === "COMMAND_FAILED" || err.code === "SPAWN_FAILED") {
      return die(
        EXIT.BUILD,
        `准备依赖或构建失败：${err.message}`,
        "上面是 npm 的原始输出。网络不通时可以试 npm ci --offline；反复失败就把这段输出发给作者。",
      );
    }
    if (err.code === "BUILD_INCOMPLETE") {
      return die(
        EXIT.BUILD,
        `构建命令跑完了但产物不全：${err.message}`,
        "在 coding/ 下手工跑一次 npm run build 看具体报错。",
      );
    }
    return die(EXIT.ENV, err.message);
  }
}

if (isMain(import.meta.url)) process.exitCode = main();

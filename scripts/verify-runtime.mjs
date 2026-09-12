#!/usr/bin/env node
// 运行环境自检（开发文档 §五 T3）。把「现在到底是什么状态」变成一个能回答的结构化报告，
// 供 bootstrap.mjs 决策、供 --json 排查、供单测断言。
//
// 用法：node scripts/verify-runtime.mjs [--json] [--target darwin-x64]
// 退出码：0 就绪 / 3 需要装或修（报告里写明缺哪一块）

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  CODING_DIR,
  EXIT,
  REPO_ROOT,
  detail,
  expectedChecksum,
  fingerprint,
  isMain,
  loadManifest,
  nodeBinDir,
  depsFingerprint,
  nodeExecutable,
  nodeHome,
  platformTarget,
  readStamp,
  resolvePort,
  step,
} from "./lib.mjs";

/** 依赖清单指纹：装出来的 node_modules 会变吗？见 lib.depsFingerprint。 */
export function depsKey(codingDir = CODING_DIR) {
  return depsFingerprint(codingDir);
}

/**
 * 源码指纹：决定要不要重新构建。
 * 只看得到的东西：服务端 src、两个前端 src、构建配置、清单、Skills 配置。
 * 不比对 mtime 而比对内容哈希，避免「git checkout 把时间戳刷新了但内容没变」导致的白等构建。
 */
export function sourceKey(codingDir = CODING_DIR) {
  const files = [];
  const walk = (dir, exclude = false) => {
    const abs = path.join(codingDir, dir);
    if (!fs.existsSync(abs)) return;
    for (const item of fs.readdirSync(abs, { withFileTypes: true })) {
      if (["node_modules", "dist", "data", ".runtime", "logs"].includes(item.name))
        continue;
      const rel = path.join(dir, item.name);
      if (item.isDirectory()) walk(rel);
      else files.push(rel);
    }
  };
  walk(path.join("src"));
  walk(path.join("apps", "a-frontend", "src"));
  walk(path.join("apps", "b-frontend", "src"));
  for (const extra of [
    "apps/a-frontend/index.html",
    "apps/b-frontend/index.html",
    "apps/a-frontend/vite.config.ts",
    "apps/b-frontend/vite.config.ts",
    "apps/a-frontend/tsconfig.json",
    "apps/b-frontend/tsconfig.json",
    "tsconfig.json",
    "vite.config.ts",
    "package.json",
    "../config/skills.json",
  ]) {
    if (fs.existsSync(path.join(codingDir, extra))) files.push(extra);
  }
  files.sort();
  return fingerprint(files, codingDir);
}

export function filePresent(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** 项目专用 Node 是否可用：文件在 + 真能跑 + 版本与清单一致（跑不起来比没装更糟，必须显式判）。 */
export function checkNodeExecutable(exe, expectedVersion) {
  if (!filePresent(exe)) return { ok: false, reason: "MISSING" };
  const result = spawnSync(exe, ["-p", "process.versions.node"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  if (result.error) return { ok: false, reason: "SPAWN_FAILED", detail: result.error.message };
  if (result.status !== 0)
    return { ok: false, reason: "SPAWN_FAILED", detail: `exit=${result.status}` };
  const actual = String(result.stdout ?? "").trim();
  const want = String(expectedVersion ?? "").replace(/^v/, "");
  if (actual !== want)
    return { ok: false, reason: "VERSION_MISMATCH", actual, expected: want };
  return { ok: true, actual };
}

/** 构建产物是否齐：服务端入口 + 两个前端的 index.html（阶段5 启动脚本要求三样都在）。 */
export function checkBuild(codingDir = CODING_DIR) {
  const parts = {
    server: filePresent(path.join(codingDir, "dist", "server", "index.js")),
    aFrontend: filePresent(
      path.join(codingDir, "apps", "a-frontend", "dist", "index.html"),
    ),
    bFrontend: filePresent(
      path.join(codingDir, "apps", "b-frontend", "dist", "index.html"),
    ),
  };
  return { ...parts, ok: parts.server && parts.aFrontend && parts.bFrontend };
}

export function probe(options = {}) {
  const env = options.env ?? process.env;
  const root = options.root ?? REPO_ROOT;
  const codingDir = options.codingDir ?? CODING_DIR;
  const runtimeDir = options.runtimeDir ?? path.join(root, ".runtime");

  const report = {
    ok: false,
    target: null,
    targetSupported: true,
    manifest: { present: false, nodeVersion: null, checksumPinned: false },
    node: { installed: false, exe: null, reason: null, actual: null },
    deps: {
      installed: false,
      reason: null,
      stamp: null,
      nodeModules: false,
      lockfile: filePresent(path.join(codingDir, "package-lock.json")),
    },
    build: { present: false, stale: false, parts: null },
    thirdParty: { envLocalPresent: false, cloudflaredPath: null },
    ports: {
      local: resolvePort("LOCAL_PORT", 8787, root),
      public: resolvePort("PUBLIC_PORT", 8788, root),
    },
    workbench: { bootstrapPath: "/api/local/bootstrap/<token>" },
  };

  let manifest;
  try {
    manifest = loadManifest(path.join(root, "runtime-manifest.json"));
    report.manifest.present = true;
    report.manifest.nodeVersion = manifest.nodeTag;
  } catch (err) {
    report.manifest.error = err.code ?? err.message;
    return report;
  }

  try {
    report.target = options.target ?? platformTarget(env);
    const checksum = expectedChecksum(manifest, report.target, "node");
    report.manifest.checksumPinned = Boolean(checksum);
    report.manifest.checksum = checksum;
  } catch (err) {
    if (err.code === "PLATFORM_UNSUPPORTED") {
      report.targetSupported = false;
      report.target = err.target;
      report.manifest.error = err.code;
      return report;
    }
    report.manifest.error = err.code ?? err.message;
    return report;
  }

  // 三个路径都要带上 root：单测把整个项目指向临时目录时，它们必须跟着走。
  const exe = nodeExecutable(report.target, manifest, root);
  report.node.exe = exe;
  report.node.home = nodeHome(report.target, manifest.nodeTag, root);
  report.node.binDir = nodeBinDir(report.target, manifest, root);
  const nodeCheck = checkNodeExecutable(exe, manifest.nodeTag);
  report.node.installed = nodeCheck.ok;
  report.node.reason = nodeCheck.reason ?? null;
  report.node.actual = nodeCheck.actual ?? null;

  // 依赖：装过没装过看 stamp（stamp 里记了当时用的 Node 版本，换 Node 也要重装）。
  const stamp = readStamp("deps", runtimeDir);
  report.deps.stamp = stamp;
  report.deps.nodeModules = fs.existsSync(path.join(codingDir, "node_modules"));
  // stamp 里四项全对上才算「这次不用重装」：依赖内容、Node 版本、装它时的平台、CPU 架构。
  // 平台/架构必须记：把整个目录拷到另一台机器（或从 Intel 换到 Apple 芯片）时前两项一点没变，
  // 但 node_modules 里的原生模块（better-sqlite3）是按 ABI 编译的，不重装就起不来。
  const depsUpToDate =
    Boolean(report.node.installed) &&
    stamp?.depsKey === depsKey(codingDir) &&
    stamp?.nodeVersion === manifest.nodeTag &&
    stamp?.platform === process.platform &&
    stamp?.arch === process.arch &&
    report.deps.nodeModules;
  report.deps.installed = depsUpToDate;
  report.deps.reason = depsUpToDate
    ? null
    : !stamp
      ? "NEVER_INSTALLED"
      : !report.deps.nodeModules
        ? "NODE_MODULES_MISSING"
        : stamp.nodeVersion !== manifest.nodeTag
          ? "NODE_VERSION_CHANGED"
          : stamp.platform !== process.platform || stamp.arch !== process.arch
            ? "PLATFORM_CHANGED"
            : "LOCKFILE_CHANGED";

  const build = checkBuild(codingDir);
  report.build.present = build.ok;
  report.build.parts = build;
  const buildStamp = readStamp("build", runtimeDir);
  report.build.stale = !(
    build.ok && buildStamp?.sourceKey === sourceKey(codingDir)
  );
  report.build.reason = build.ok
    ? buildStamp?.sourceKey === sourceKey(codingDir)
      ? null
      : buildStamp
        ? "SOURCE_CHANGED"
        : "NO_BUILD_STAMP"
    : !build.server
      ? "SERVER_DIST_MISSING"
      : "FRONTEND_DIST_MISSING";

  // 第三方组件：只报「装没装」，条款确认由 prepare-cloudflared 自己管（它有交互式同意 + 签名校验）。
  const envLocal = path.join(root, ".env.local");
  report.thirdParty.envLocalPresent = fs.existsSync(envLocal);
  if (fs.existsSync(envLocal)) {
    const line = fs
      .readFileSync(envLocal, "utf8")
      .split(/\r?\n/)
      .find((l) => l.startsWith("CLOUDFLARED_PATH="));
    const value = line?.slice("CLOUDFLARED_PATH=".length).trim();
    report.thirdParty.cloudflaredPath = value || null;
    report.thirdParty.cloudflaredPresent = value ? fs.existsSync(value) : false;
  }

  report.ok =
    report.manifest.present &&
    report.targetSupported &&
    report.manifest.checksumPinned &&
    report.node.installed &&
    report.deps.installed &&
    !report.build.stale;
  return report;
}

export function main(argv = process.argv.slice(2)) {
  const asJson = argv.includes("--json");
  const report = probe({ target: argValue(argv, "--target") });
  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.ok ? EXIT.OK : EXIT.ENV;
  }
  step("CHECKING_RUNTIME");
  detail(`平台：${report.target ?? "?"}（清单支持：${report.targetSupported ? "是" : "否"}）`);
  detail(
    `Node：${report.node.installed ? `已就绪 ${report.node.actual}` : `未就绪（${report.node.reason}）`}`,
  );
  detail(
    `依赖：${report.deps.installed ? "已安装" : `需要安装（${report.deps.reason}）`}`,
  );
  detail(
    `构建：${report.build.present && !report.build.stale ? "已是最新" : `需要构建（${report.build.reason}）`}`,
  );
  detail(
    `公网通道组件：${report.thirdParty.cloudflaredPresent ? "已准备" : "未准备（首次启动公网功能时会先征求你的同意）"}`,
  );
  detail(`端口：A ${report.ports.local} / B ${report.ports.public}`);
  return report.ok ? EXIT.OK : EXIT.ENV;
}

function argValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

if (isMain(import.meta.url)) process.exitCode = main();

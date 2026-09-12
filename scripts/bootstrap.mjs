#!/usr/bin/env node
// 阶段5 准备流程总控（PRD §6.1、§12.2 全量状态机；开发文档 §三 §五）。
//
// 谁调用它：
//   start-macos.command / start-windows.bat 这些引导层。它们先把「项目专用 Node」弄出来（那份下载逻辑
//   不依赖 Node，因为系统里可能一个 Node 都没有），然后交给这里做后面所有事。
//   也可以直接在终端跑：node scripts/bootstrap.mjs（开发者路径，用系统 Node 也认，见下面的 NODE_OK_BUT_DIFFERENT）。
//
// 本脚本自己不下载 Node —— 它是「编排 + 复核」：该装的时候调 node-bootstrap.mjs，
// 该装依赖的时候调 prepare-deps.mjs，最后交给 start.mjs 起服务。
// 每一步都可以在 --dry-run 下看决策结果，不写任何东西。
//
// 用法：node scripts/bootstrap.mjs [--dry-run] [--no-open] [--force-deps] [--force-build] [--skip-tunnel]
// 退出码：见 lib.mjs 的 EXIT 表

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
  loadManifest,
  platformTarget,
  step,
} from "./lib.mjs";
import { installProjectNode } from "./node-bootstrap.mjs";
import { ensureBuild, ensureDeps } from "./prepare-deps.mjs";
import { probe } from "./verify-runtime.mjs";
import { start } from "./start.mjs";

/**
 * 主流程。返回 {code, stage, message}，不直接 exit —— 单测要能拿到中间结果。
 */
export async function bootstrap(options = {}) {
  const env = options.env ?? process.env;
  const root = options.root ?? REPO_ROOT;
  const log = options.step ?? step;
  const note = options.detail ?? detail;
  const dryRun = options.dryRun ?? false;

  // 1) 平台
  let target;
  let manifest;
  log("CHECKING_PLATFORM");
  try {
    target = options.target ?? platformTarget(env);
    manifest = loadManifest(path.join(root, "runtime-manifest.json"));
  } catch (err) {
    if (err.code === "PLATFORM_UNSUPPORTED") {
      return {
        code: EXIT.PLATFORM,
        stage: "platform",
        message: `这台机器的平台 ${err.target} 不在支持列表内（本项目支持 macOS 与 Windows x64）。`,
      };
    }
    return {
      code: EXIT.ENV,
      stage: "manifest",
      message:
        err.code === "RUNTIME_MANIFEST_MISSING"
          ? "找不到 runtime-manifest.json，项目目录不完整。"
          : `读运行环境清单失败：${err.message}`,
      hint:
        err.code === "RUNTIME_MANIFEST_MISSING"
          ? "重新获取完整项目目录（不要只拷几个文件）。"
          : "",
    };
  }
  note(`目标平台 ${target}，项目专用 Node ${manifest.nodeTag}`);

  // 2) 运行环境
  let report = probe({ root, target, env });
  if (!report.node.installed && !dryRun) {
    log("CHECKING_RUNTIME", `项目专用 Node 未就绪（${report.node.reason}），开始准备`);
    try {
      const result = await installProjectNode({
        env,
        manifest,
        target,
        // 清单没钉这个平台的校验值时 installProjectNode 会抛，绝不降级为「那就不校验」
      });
      note(
        result.reason === "ALREADY_READY"
          ? `复用 ${result.exe}`
          : `已安装 ${result.version} → ${path.relative(root, result.home)}`,
      );
    } catch (err) {
      return runtimeFailure(err);
    }
    report = probe({ root, target, env });
  }
  if (dryRun) {
    note(
      `dry-run：node=${report.node.installed ? "已就绪" : "需要安装"} deps=${report.deps.installed ? "跳过安装" : `需要安装（${report.deps.reason}）`} build=${report.build.stale ? `需要构建（${report.build.reason}）` : "跳过"} cloudflared=${report.thirdParty.cloudflaredPresent ? "已准备" : "未准备"} 端口 A ${report.ports.local} / B ${report.ports.public}`,
    );
    return { code: EXIT.OK, stage: "dry-run", dryRun: report };
  }
  if (!report.node.installed) {
    return {
      code: EXIT.ENV,
      stage: "runtime",
      message: `运行环境仍然不可用（${report.node.reason}${report.node.actual ? `，实际 ${report.node.actual}` : ""}）。`,
      hint: "跑 node scripts/node-bootstrap.mjs --force 看详细报错。",
    };
  }
  if (process.version !== report.manifest.nodeVersion) {
    // 用系统 Node 跑脚本、用项目 Node 跑服务，是允许的组合（开发者常这样）。
    note(
      `当前脚本跑在系统 Node ${process.version} 上，服务会用项目专用 ${report.manifest.nodeVersion}（NODE_OK_BUT_DIFFERENT）`,
    );
  }

  // 3) 依赖与构建
  try {
    const deps = ensureDeps({
      root,
      target,
      manifest,
      report,
      env,
      force: options.forceDeps,
    });
    note(deps.action === "skip" ? "依赖已是最新（内容指纹一致）" : "依赖安装完成");
    const build = ensureBuild({
      root,
      target,
      manifest,
      report,
      env,
      force: options.forceBuild,
    });
    note(build.action === "skip" ? "构建产物与源码一致，跳过" : "构建完成");
  } catch (err) {
    return {
      code: EXIT.BUILD,
      stage: "deps",
      message: `准备依赖或构建失败：${err.message}`,
      hint: "上面是 npm 的原样输出。网络不通就换网络；反复失败把这段输出发给作者。",
    };
  }

  // 4) 公网通道组件（第三方，需要用户同意，PRD §10.3 §13.2）
  if (!options.skipTunnel) {
    const receipt = ensureCloudflared({ root, env, note });
    if (receipt.skipped) {
      note("没有准备 cloudflared：B 链接会走局域网地址，或者在 .env.example 里填 PUBLIC_BASE_URL");
    }
  }

  // 5) 起服务（前台常驻）
  return start({
    env,
    manifest,
    target,
    open: options.open !== false,
    nodeExe: report.node.exe,
    ports: { local: report.ports.local, public: report.ports.public },
    foreground: options.foreground !== false,
  });
}

/**
 * cloudflared 的准备完全交给已有的 coding/scripts/prepare-cloudflared.mjs：
 * 它管条款确认（要用户输 yes）、平台签名、钉死的 sha256、写 CLOUDFLARED_PATH。
 * 这里只负责在启动流程里叫它一次，并且**不吞掉它的退出码含义**：
 * 用户拒绝条款 / 下载失败都不是启动失败 —— 局域网模式仍然可用。
 */
export function ensureCloudflared({ root = REPO_ROOT, env = process.env, note = detail } = {}) {
  const script = path.join(CODING_DIR, "scripts", "prepare-cloudflared.mjs");
  const envLocal = path.join(root, ".env.local");
  const already = (() => {
    try {
      const line = fs
        .readFileSync(envLocal, "utf8")
        .split(/\r?\n/)
        .find((l) => l.startsWith("CLOUDFLARED_PATH="));
      const value = line?.slice("CLOUDFLARED_PATH=".length).trim();
      return Boolean(value && fs.existsSync(value));
    } catch {
      return false;
    }
  })();
  if (already) return { skipped: false, action: "reuse" };
  if (!fs.existsSync(script)) return { skipped: true, reason: "SCRIPT_MISSING" };

  const nodeExe = env.AIW_NODE_EXE ?? process.execPath;
  const result = spawnSync(nodeExe, [script], {
    cwd: CODING_DIR,
    env: { ...env },
    // 交互式：条款要用户自己回答。stdio inherit 才能读到 stdin（--yes 才跳过）。
    stdio: "inherit",
    timeout: 10 * 60_000,
  });
  if (result.status !== 0) {
    note(`cloudflared 准备没成功（退出码 ${result.status}）—— 不影响本机使用，公网链接这一项先空着`);
    return { skipped: true, reason: `PREPARE_EXIT_${result.status}` };
  }
  return { skipped: false, action: "prepared" };
}

function runtimeFailure(err) {
  if (err.code === "CHECKSUM_MISMATCH") {
    return {
      code: EXIT.NETWORK,
      stage: "runtime",
      message:
        "下载到的 Node 与清单里的 SHA-256 不一致，已经删掉，不会执行它。",
      hint: "换网络重试。要换镜像源可以设 AIWINDOW_NODE_BASE，但校验值不会因此改变。",
    };
  }
  if (err.code === "RUNTIME_MANIFEST_INCOMPLETE") {
    return {
      code: EXIT.ENV,
      stage: "runtime",
      message: "这一版项目没有为你这台机器把过关（清单里缺这个平台的校验值）。",
      hint: "不要在本地改清单凑数，找作者用 gen-runtime-manifest.mjs 补。",
    };
  }
  return {
    code: EXIT.NETWORK,
    stage: "runtime",
    message: `准备运行环境失败：${err.message}`,
    hint: "看网络；离线环境请找作者要带 .runtime 的完整包。",
  };
}

function argValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function main(argv = process.argv.slice(2)) {
  return bootstrap({
    dryRun: argv.includes("--dry-run"),
    open: !argv.includes("--no-open"),
    forceDeps: argv.includes("--force-deps"),
    forceBuild: argv.includes("--force-build"),
    skipTunnel: argv.includes("--skip-tunnel"),
    target: argValue(argv, "--target"),
  }).then((result) => {
    if (result.code !== EXIT.OK) {
      return die(result.code, result.message ?? `启动失败（阶段：${result.stage}）`, result.hint);
    }
    return EXIT.OK;
  });
}

if (isMain(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}

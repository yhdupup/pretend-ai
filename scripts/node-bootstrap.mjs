#!/usr/bin/env node
// 项目专用 Node 的下载 / 校验 / 落地（PRD §12.2 第 2~5 步）。
//
// 与引导层（start-macos.command / bootstrap.ps1）的关系：
//   那两个文件里也有一份下载逻辑，这是刻意的 —— PRD 要求「第一次自举不依赖 Node」，
//   所以系统里一个 Node 都没有的时候必须由 shell 自己把包拉下来。
//   本文件负责的是「已经有项目 Node 但要换版本 / 坏了要修」这条路，以及作为唯一被单测覆盖的实现；
//   引导层装完之后会调 verify-runtime.mjs 复核，两边用的是同一份清单与同一套判定。
//
// 顺序不可调换：下载 → .part → SHA-256 对清单 → 才解压 → 才 chmod → 才试跑。
// 没有「跳过校验」开关；镜像只能换主机（AIWINDOW_NODE_BASE），换不了校验值。
//
// 用法：node scripts/node-bootstrap.mjs [--force] [--target darwin-arm64] [--url <file:// 或 https://>] [--sha256 <hex>]
// 退出码：0 就绪 / 3 清单或平台问题 / 7 下载与校验失败

import fs from "node:fs";
import path from "node:path";
import {
  EXIT,
  REPO_ROOT,
  allowsLocalFixture,
  detail,
  die,
  downloadAndVerify,
  makeProgressPrinter,
  expectedChecksum,
  extractArchive,
  isMain,
  loadManifest,
  nodeArchiveUrl,
  nodeExePath,
  nodeHome,
  platformTarget,
  step,
} from "./lib.mjs";
import { checkNodeExecutable } from "./verify-runtime.mjs";

export function argValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/**
 * 装（或修）项目专用 Node。
 * root / manifest 可注入，单测就在临时目录里跑完整流程（file:// 喂一个假包，不碰网络）。
 */
export async function installProjectNode(options = {}) {
  const env = options.env ?? process.env;
  const root = options.root ?? REPO_ROOT;
  const manifest = options.manifest ?? loadManifest();
  const target = options.target ?? platformTarget(env);
  const force = options.force ?? false;

  const home = nodeHome(target, manifest.nodeTag, root);
  const exe = options.exe ?? nodeExePath(home, target);
  const expected =
    options.sha256 ?? expectedChecksum(manifest, target, "node");

  const verdict = checkNodeExecutable(exe, manifest.nodeTag);
  if (verdict.ok && !force) {
    return { installed: false, reason: "ALREADY_READY", exe, target, home };
  }

  // 包名必须由清单钉死：按规则拼出来的名字听上去一样，但「一样」不是校验，写错版本就装错东西。
  if (!manifest.nodeTargets?.[target]?.artifact) {
    const err = new Error(`RUNTIME_MANIFEST_INCOMPLETE: 清单里没有 ${target} 的包名`);
    err.code = "RUNTIME_MANIFEST_INCOMPLETE";
    throw err;
  }
  const url = options.url ?? nodeArchiveUrl(manifest, target, env);

  const archive = path.join(root, ".runtime", "download", path.basename(url));
  if (!url.startsWith("file://")) {
    const host = new URL(url).host;
    const official = new URL(manifest.nodeMirrorBase).host;
    step("DOWNLOADING_NODE", url);
    if (host !== official) detail(`正在从 ${host} 下载，校验值仍然用官方清单里的那一个`);
  } else {
    step("DOWNLOADING_NODE", "本地测试包（只有清单开了 allowLocalFixture 才允许）");
  }
  // 闸门只看清单：用户机器上的真实清单永远没有这个键，file:// 这条路就是死的。
  await downloadAndVerify(url, archive, expected, {
    localFixture: allowsLocalFixture(manifest),
    // 慢网下这一步可能要几分钟。没有进度就等于没有反馈，用户只会以为卡死然后强退。
    // 本地测试包（file://）不打印：它是同步拷贝，进度没有意义，还会污染测试输出。
    onProgress:
      options.quiet || url.startsWith("file://")
        ? null
        : makeProgressPrinter({ label: "正在下载 Node" }),
  });
  detail("校验通过，开始解压");

  step("VERIFYING_NODE");
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  extractArchive(archive, home, { strip: 1 });
  fs.rmSync(archive, { force: true });

  if (!target.startsWith("win")) {
    // 解压出来的 bin/node 权限由 tar 保留，但镜像/手工放置的包可能没有执行位，补一次。
    try {
      fs.chmodSync(exe, 0o755);
    } catch {
      /* 找不到 exe 交给下面的试跑去报错，这里不掩盖 */
    }
  }

  const after = checkNodeExecutable(exe, manifest.nodeTag);
  if (!after.ok) {
    const err = new Error(`RUNTIME_UNUSABLE: ${after.reason} ${after.detail ?? ""}`);
    err.code = "RUNTIME_UNUSABLE";
    throw err;
  }
  return { installed: true, exe, target, home, version: after.actual };
}

export function main(argv = process.argv.slice(2)) {
  try {
    const env = process.env;
    const manifest = loadManifest();
    const target = argValue(argv, "--target") ?? platformTarget(env);
    const url = argValue(argv, "--url");
    const sha256 = argValue(argv, "--sha256");
    return installProjectNode({
      env,
      manifest,
      target,
      force: argv.includes("--force"),
      url,
      sha256,
    })
      .then((result) => {
        if (result.reason === "ALREADY_READY") {
          step("VERIFYING_NODE", `已就绪：${result.exe}`);
        } else {
          step("DONE", `项目专用 Node ${result.version} 已装到 .runtime`);
        }
        return EXIT.OK;
      })
      .catch((err) => {
        if (err.code === "CHECKSUM_MISMATCH") {
          return die(
            EXIT.NETWORK,
            "下载到的运行环境与清单里的校验值不一致，已删除，不会执行它。",
            "多半是网络被劫持或镜像不对。换网络重试，或先核对 runtime-manifest.json。",
          );
        }
        if (err.code === "NETWORK_STALLED") {
          // 卡住和断网是两回事：断网重试就行，卡住通常是直连被限速，换镜像才有用。
          return die(
            EXIT.NETWORK,
            "下载运行环境时连接卡住了（30 秒没有新字节），已经停下来。",
            "换网络重试；直连很慢就设镜像：AIWINDOW_NODE_BASE=https://npmmirror.com/mirrors/node（校验值不变）。",
          );
        }
        if (err.code === "LOCAL_FIXTURE_NOT_ALLOWED") {
          return die(
            EXIT.ENV,
            "清单没开本地包开关，不允许从本地文件拿运行时。",
            "这是防「有人把改过的 Node 塞进项目目录」的闸门，正常启动不会走到这里。",
          );
        }
        if (err.code === "PLATFORM_UNSUPPORTED") {
          return die(
            EXIT.PLATFORM,
            `这台机器的平台（${err.target}）不在支持列表里。`,
            "本项目支持 macOS（Apple 芯片 / Intel）与 Windows x64。",
          );
        }
        return die(
          EXIT.NETWORK,
          `准备运行环境失败：${err.message}`,
          "检查网络；急用可以手工把 node 装到 .runtime/node/<版本>/<平台>/ 再重试。",
        );
      });
  } catch (err) {
    if (err.code === "RUNTIME_MANIFEST_MISSING") {
      return die(
        EXIT.ENV,
        "找不到 runtime-manifest.json（项目自带文件，应该和 scripts/ 同级）。",
        "确认下载的是完整项目目录，不是零散文件。",
      );
    }
    if (err.code === "RUNTIME_MANIFEST_INCOMPLETE") {
      return die(
        EXIT.ENV,
        "runtime-manifest.json 里没有这个平台的校验值，说明这一版项目没为它把关过。",
        "不要在本地改清单凑数；找作者补 gen-runtime-manifest.mjs 生成的值。",
      );
    }
    return die(EXIT.ENV, err.message);
  }
}

if (isMain(import.meta.url)) {
  Promise.resolve(main()).then((code) => {
    process.exitCode = code;
  });
}

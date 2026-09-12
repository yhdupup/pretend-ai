#!/usr/bin/env node
// 生成 / 更新项目根目录的 runtime-manifest.json（PRD §12.2 第 3~5 步要求钉死版本与校验值）。
//
// 为什么要有这个生成器，而不是手写清单：
// Node 的 SHA-256 是官方发布清单里现成的，手抄一位错 = 全机用户永久装不上，
// 而且错了以后本地还能跑（本机 .runtime 已经装好了），只有新电脑才会暴露 —— 这正是最坏的错误。
//
// 两个来源的可信度不一样，写得很明白：
//   node：直接取 https://nodejs.org/dist/v<版本>/SHASUMS256.txt（官方发布清单，机器可比对）；
//   cloudflared：GitHub release 不提供校验文件（2025.4.2 实测 26 个产物里没有 SHA256SUMS），
//     所以这里的值是「第一次下载后本地取值 + 人工核对 + 之后每次复核」，
//     真实性由 prepare-cloudflared.mjs 的平台签名兜（macOS codesign Team ID / Windows Authenticode）。
//     没取到值的平台是 null —— 表示「还没有为这个平台把关」，脚本遇到 null 会拒绝下载而不是放行。
//
// 用法：
//   node coding/scripts/gen-runtime-manifest.mjs                 # 按当前 coding/package.json engines 或 --node 生成
//   node coding/scripts/gen-runtime-manifest.mjs --node v24.18.1
//   node coding/scripts/gen-runtime-manifest.mjs --offline       # 只重排现有清单，不联网（网络不通时用）
//
// 退出码：0 成功；1 拿不到清单（不会写出半残文件）。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const codingRoot = path.resolve(here, "..");
const repoRoot = path.resolve(codingRoot, "..");
const manifestPath = path.join(repoRoot, "runtime-manifest.json");
const legacyChecksums = path.join(codingRoot, "config", "runtime-checksums.json");

// 本项目只需要这三个目标（PRD §12.2：macOS 双击 / Windows 双击）。Linux 暂不在支持矩阵里。
const NODE_TARGETS = {
  "darwin-arm64": "node-v%VERSION%-darwin-arm64.tar.gz",
  "darwin-x64": "node-v%VERSION%-darwin-x64.tar.gz",
  "win-x64": "node-v%VERSION%-win-x64.zip",
};

const CLOUDFLARED_TARGETS = {
  "darwin-arm64": "cloudflared-darwin-arm64",
  "darwin-x64": "cloudflared-darwin-amd64",
  "win-x64": "cloudflared-windows-amd64",
};

const argv = process.argv.slice(2);
const flagValue = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? "") : "";
};
const offline = argv.includes("--offline");

function currentVersion() {
  const explicit = flagValue("node");
  if (explicit) return explicit.startsWith("v") ? explicit : `v${explicit}`;
  const pkg = JSON.parse(
    fs.readFileSync(path.join(codingRoot, "package.json"), "utf8"),
  );
  const engines = pkg.engines?.node ?? "";
  const match = String(engines).match(/(\d+\.\d+\.\d+)/);
  if (match) return `v${match[1]}`;
  // 没有精确版本就别猜：写进清单的版本必须是人工挑定过的。
  throw new Error(
    "package.json engines.node 里没有精确版本；用 --node v24.18.1 显式指定",
  );
}

function legacyCloudflared() {
  try {
    const table = JSON.parse(fs.readFileSync(legacyChecksums, "utf8"));
    const out = {};
    for (const [key, value] of Object.entries(table)) {
      if (key.startsWith("$") || !value) continue;
      const [artifact, version] = key.split("/");
      out[version] = out[version] ?? {};
      out[version][artifact] = value;
    }
    return out;
  } catch {
    return {};
  }
}

async function fetchNodeChecksums(version) {
  const url = `https://nodejs.org/dist/${version}/SHASUMS256.txt`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`拿不到 ${url}：HTTP ${res.status}`);
  const text = await res.text();
  const map = {};
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2 && /^[0-9a-f]{64}$/.test(parts[0] ?? "")) {
      map[parts[1]] = parts[0];
    }
  }
  return map;
}

function existingManifest() {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
}

function build() {
  const previous = existingManifest();
  const legacy = legacyCloudflared();
  const version = currentVersion();

  let nodeMap = null;
  if (!offline) {
    nodeMap = fetchNodeChecksums(version);
  }

  return Promise.resolve(nodeMap).then(async (sums) => {
    const targets = {};
    for (const [target, pattern] of Object.entries(NODE_TARGETS)) {
      const artifact = pattern.replace("%VERSION%", version.slice(1));
      if (sums) {
        const sha = sums[artifact];
        if (!sha) throw new Error(`官方清单里没有 ${artifact}，先确认版本号填对没有`);
        targets[target] = { artifact, sha256: sha };
      } else {
        // --offline：保留原值，缺的一律 null（下游脚本遇到 null 会拒绝下载，不会静默放行）
        const prev = previous?.node?.targets?.[target];
        targets[target] = {
          artifact,
          sha256: prev?.sha256 ?? null,
        };
      }
    }

    const cfVersion =
      flagValue("cloudflared") ||
      previous?.cloudflared?.version ||
      Object.keys(legacy)[0] ||
      "2025.4.2";
    const cfTable = legacy[cfVersion] ?? {};
    const cfTargets = {};
    for (const [target, artifact] of Object.entries(CLOUDFLARED_TARGETS)) {
      const package_ = process.platform === "win32" ? artifact : `${artifact}.tgz`;
      cfTargets[target] = {
        artifact: target === "win-x64" ? `${artifact}.exe` : `${artifact}.tgz`,
        // 归档里的文件名与落到磁盘上的文件名一致，Windows 的包是裸 .exe
        binName: target === "win-x64" ? "cloudflared.exe" : "cloudflared",
        package: package_,
        sha256: cfTable[artifact] ?? previous?.cloudflared?.targets?.[target]?.sha256 ?? null,
      };
    }

    return {
      $comment:
        "项目专用运行时清单（PRD §12.2）。版本与 SHA-256 一律钉死：脚本只认这里列出的字节。镜像只能换主机（AIWINDOW_NODE_BASE / AIWINDOW_TUNNEL_BASE），不能换校验值，也没有「跳过校验」开关。null 表示该平台还没有把关值，脚本会拒绝下载。生成方式：node coding/scripts/gen-runtime-manifest.mjs（Node 的值来自 nodejs.org 官方 SHASUMS256.txt；cloudflared 官方不发校验文件，值是首次下载后人工核对钉下来的，运行时另加平台签名校验）。",
      generatedBy: "coding/scripts/gen-runtime-manifest.mjs",
      generatedAt: new Date().toISOString(),
      node: {
        version,
        // 长驻版本说明：换版本要人工改 engines 再跑本脚本，不要手抄哈希。
        checksumHost: "https://nodejs.org/dist",
        mirrorBase: "https://nodejs.org/dist",
        targets,
      },
      cloudflared: {
        version: cfVersion,
        releaseUrl:
          "https://github.com/cloudflare/cloudflared/releases/download",
        provenance:
          "GitHub release 无官方校验文件；sha256 为首次下载取值钉死，运行时另做 macOS codesign(TeamID 68WVV388M8) / Windows Authenticode(Cloudflare) 校验",
        targets: cfTargets,
      },
      paths: {
        runtimeDir: ".runtime",
        nodeDir: ".runtime/node",
      },
    };
  });
}

build()
  .then((manifest) => {
    fs.writeFileSync(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    console.log(`已写入 ${path.relative(repoRoot, manifestPath)}`);
    for (const [target, entry] of Object.entries(manifest.node.targets)) {
      console.log(
        `  node ${target}: ${entry.sha256 ? `${entry.sha256.slice(0, 12)}…` : "null（未把关）"}  ${entry.artifact}`,
      );
    }
    for (const [target, entry] of Object.entries(manifest.cloudflared.targets)) {
      console.log(
        `  cloudflared ${target}: ${entry.sha256 ? `${entry.sha256.slice(0, 12)}…` : "null（未把关）"}  ${entry.artifact}`,
      );
    }
    console.log(
      `\n下次换 Node 版本：改 coding/package.json 的 engines.node，再跑一次本脚本。不要手填哈希。`,
    );
  })
  .catch((err) => {
    console.error(`生成失败：${err.message}`);
    console.error(
      "不会写出半残清单。网络不通时可以用 --offline 保留现有值（缺的目标仍是 null，脚本会拒绝下载该平台）。",
    );
    process.exitCode = 1;
  });

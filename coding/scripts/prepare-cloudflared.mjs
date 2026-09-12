#!/usr/bin/env node
// 把 cloudflared 准备到本地，免手工安装；顺带把 PRD §10.3/§12.2/§13.1/§13.2/§24.4 要求的
// 三件事做掉：跑第三方软件前显式确认条款、下载产物必须校验、不碰用户自己的 ~/.cloudflared。
//
// 顺序：已在 PATH 里 → 直接用；coding/bin/cloudflared 已存在 → 复核后复用；否则确认后按平台下载。
// 找到 / 下载完之后把绝对路径写进 .env.local 的 CLOUDFLARED_PATH，
// 这样服务端不依赖 PATH（从桌面图标、launchd、CI 里起进程都找得到）。
//
// 两种用法（开发文档 §5.5 要求「既能 CLI 调用也能被 import」）：
//   CLI：   node scripts/prepare-cloudflared.mjs [--yes] [--force] [--json]
//   import：import { prepareCloudflared } from "../scripts/prepare-cloudflared.mjs"
//           → await prepareCloudflared({ assumeYes: true })
// 启动脚本（scripts/bootstrap.mjs）是以子进程方式调用它的，不是 import：
// 条款确认要读用户敲的 stdin、要把进度原样打到终端，import 进来反而要把这些流手工转发一遍。
// 但函数确实导出了，单测与别的工具可以直接用，不会再出现「一 import 就下载」。
//
// 退出码：0 成功或用户没确认条款；1 校验失败/下载失败（PATH 里有东西时不报错，交给隧道层自己试）。

import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const binDir = path.join(projectRoot, "bin");
// 这份「本机装了什么、从哪来、哈希多少」的记录，以前叫 runtime-manifest.json ——
// 和仓库根目录那份真正钉死版本的 runtime-manifest.json 撞名，看日志的人分不清谁是权威。
// 它是下载之后写出来的回执，所以改成 cloudflared-receipt.json（旧文件读到时自动迁移）。
const manifestPath = path.join(binDir, "cloudflared-receipt.json");
const legacyReceiptPath = path.join(binDir, "runtime-manifest.json");
const checksumTablePath = path.join(
  projectRoot,
  "config",
  "runtime-checksums.json",
);
const envLocal = path.join(projectRoot, "..", ".env.local");
const termsReceipt = path.join(binDir, "third-party-terms.json");

const VERSION = process.env.CLOUDFLARED_VERSION ?? "2025.4.2";
// Cloudflare 的开发者签名主体（macOS codesign / Windows Authenticode 用它判真伪）。
// 换版本不需要改这里，换发行方才需要。
const VENDOR_TEAM_ID = process.env.CLOUDFLARED_TEAM_ID ?? "68WVV388M8";
const VENDOR_NAME = /cloudflare/i;

/** 只在「直接跑这个文件」时才解析命令行、才执行流程（import 进来什么都不发生）。 */
function isMainEntry() {
  const entry = process.argv[1];
  return Boolean(entry) && path.resolve(entry) === fileURLToPath(import.meta.url);
}

const cliArgv = process.argv.slice(2);
const cliOptions = {
  assumeYes: cliArgv.includes("--yes"),
  force: cliArgv.includes("--force"),
  json: cliArgv.includes("--json"),
};

function targetName() {
  if (process.platform === "win32") return "cloudflared-windows-amd64";
  if (process.platform === "darwin")
    return process.arch === "arm64"
      ? "cloudflared-darwin-arm64"
      : "cloudflared-darwin-amd64";
  return process.arch === "arm64"
    ? "cloudflared-linux-arm64"
    : "cloudflared-linux-amd64";
}

function downloadUrl() {
  // 镜像只能换主机名，不能换文件、更不能换校验值（与 lib.nodeArchiveUrl 同一口径）。
  // 不填就用官方 release 地址。本机的钉死哈希存在 bin/cloudflared-receipt.json 与根目录清单里，
  // 两者都不受这个变量影响，所以镜像做不到「把坏包说成好包」。
  const mirror = (process.env.AIWINDOW_TUNNEL_BASE ?? "").trim().replace(/\/+$/, "");
  const base = mirror || `https://github.com/cloudflare/cloudflared/releases/download/${VERSION}`;
  if (mirror && !/^https?:\/\//.test(mirror)) {
    // 写了个没协议的主机名：直接拒，不拼出一个看起来正常的相对路径。
    throw new Error(`AIWINDOW_TUNNEL_BASE 必须带 https:// 前缀，当前值：${mirror}`);
  }
  if (process.platform === "win32") return `${base}/cloudflared-windows-amd64.exe`;
  if (process.platform === "darwin") return `${base}/${targetName()}.tgz`;
  return `${base}/${targetName()}`;
}

function onPath() {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(cmd, ["cloudflared"], { encoding: "utf8" })
      .trim()
      .split("\n")[0];
    return out ? path.resolve(out) : null;
  } catch {
    return null;
  }
}

function alreadyInstalled() {
  for (const name of ["cloudflared", "cloudflared.exe"]) {
    const p = path.join(binDir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function sha256(file) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

function pinnedChecksum() {
  try {
    const table = JSON.parse(fs.readFileSync(checksumTablePath, "utf8"));
    const key = `${targetName()}/${VERSION}`;
    return { key, value: table[key] ?? null };
  } catch (err) {
    console.warn(
      `[cloudflared] 读不到校验值表（${err.code}），本次只能靠平台签名与版本号把关`,
    );
    return { key: `${targetName()}/${VERSION}`, value: null };
  }
}

// 真正的“来源可信”判断：GitHub 不给 cloudflared 发布校验文件，所以
// macOS 走开发者签名，Windows 走 Authenticode，Linux 只能靠钉死的 sha256。
// enforcePinned：只有「我们自己下载/存在 bin 下」的文件才拿钉死的 sha256 卡它。
// 用户自己用 brew/apt 装的走的是另一条渠道，哈希本来就可能不一样，那种只做签名与版本检查。
async function verifyProvenance(binary, { enforcePinned }) {
  const checks = [];
  if (process.platform === "darwin") {
    const detail = spawnSync("codesign", ["-dvv", binary], {
      encoding: "utf8",
    });
    const text = `${detail.stdout ?? ""}${detail.stderr ?? ""}`;
    const team =
      new RegExp(`TeamIdentifier=?\\s*${VENDOR_TEAM_ID}`).test(text) ||
      text.includes(`(${VENDOR_TEAM_ID})`);
    const strict = spawnSync("codesign", ["--verify", "--strict", binary], {
      encoding: "utf8",
    });
    if (strict.status !== 0)
      throw new Error(
        `代码签名校验没过（codesign --verify）：${strict.stderr.trim().slice(0, 200)}`,
      );
    if (!team)
      throw new Error(
        `签名不是 Cloudflare 的开发者证书（期望 Team ID ${VENDOR_TEAM_ID}），拒绝执行`,
      );
    checks.push("macos-codesign:Cloudflare");
  } else if (process.platform === "win32") {
    const ps = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `$s=Get-AuthenticodeSignature '${binary}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`,
      ],
      { encoding: "utf8" },
    );
    const out = (ps.stdout ?? "").trim();
    if (ps.status !== 0 || !out) {
      throw new Error(
        "拿不到 Windows 数字签名状态（Get-AuthenticodeSignature），拒绝执行；要跳过就手工安装并确认来源",
      );
    }
    const [status, subject = ""] = out.split("|");
    if (status !== "Valid")
      throw new Error(`Authenticode 状态是 ${status}，不是 Valid，拒绝执行`);
    if (!VENDOR_NAME.test(subject))
      throw new Error(`签名主体不是 Cloudflare：${subject.slice(0, 120)}`);
    checks.push("windows-authenticode:Valid");
  }

  const { key, value } = pinnedChecksum();
  const digest = await sha256(binary);
  if (value && enforcePinned) {
    if (value !== digest) {
      throw new Error(
        `sha256 与钉死值不一致（${key}）：期望 ${value}，实际 ${digest}。文件可能被动过，拒绝执行`,
      );
    }
    checks.push(`sha256:pinned:${digest.slice(0, 12)}`);
  } else {
    if (value)
      checks.push(`sha256:skipped-for-user-install:${digest.slice(0, 12)}`);
    else checks.push(`sha256:recorded:${digest.slice(0, 12)}`);
    if (!value)
      console.warn(
        `[cloudflared] ${key} 没有钉死的 sha256（官方 release 不发校验文件），本次记录的哈希是 ${digest}\n` +
          `[cloudflared] 建议核对无误后写进 config/runtime-checksums.json，之后每次复用都会复核`,
      );
  }

  const versionText = execFileSync(binary, ["--version"], {
    encoding: "utf8",
  }).trim();
  if (!versionText.includes(VERSION)) {
    throw new Error(
      `版本对不上：期望 ${VERSION}，实际「${versionText}」，拒绝执行`,
    );
  }
  return { digest, versionText, checks };
}

function writeManifest(extra) {
  fs.mkdirSync(binDir, { recursive: true });
  const entry = {
    tool: "cloudflared",
    version: VERSION,
    target: targetName(),
    ...extra,
    recordedAt: new Date().toISOString(),
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(entry, null, 2)}\n`);
  return entry;
}

function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    /* 下面是改名前的迁移路径 */
  }
  try {
    // 旧回执（改名前那份）读得到就搬走，避免下次又走一遍「没有记录」的分支。
    const legacy = JSON.parse(fs.readFileSync(legacyReceiptPath, "utf8"));
    writeManifest(legacy);
    fs.rmSync(legacyReceiptPath, { force: true });
    return legacy;
  } catch {
    return null;
  }
}

// PRD §13.2：用户自己装过 cloudflared 时，不许改名/删除它的配置，只做人话提示。
function noticeAboutUserConfig() {
  const dir = path.join(os.homedir(), ".cloudflared");
  if (!fs.existsSync(dir)) return;
  const configs = ["config.yml", "config.yaml"].filter((f) =>
    fs.existsSync(path.join(dir, f)),
  );
  console.log(
    `[cloudflared] 检测到你自己的 ~/.cloudflared${configs.length ? `（含 ${configs.join("、")}）` : ""}。` +
      `本工具不会读取、改名或删除它；用的是免账号的 Quick Tunnel 临时域名，不会占用你已配置的命名隧道。`,
  );
}

// PRD §10.3：下载并运行第三方软件前，A 必须看到「是什么、干什么、条款在哪」并明确同意。
async function confirmThirdParty(options = {}) {
  const assumeYes = options.assumeYes ?? cliOptions.assumeYes;
  const prior = (() => {
    try {
      return JSON.parse(fs.readFileSync(termsReceipt, "utf8"));
    } catch {
      return null;
    }
  })();
  console.log(
    "\n【需要你确认】本工具用一个叫 Cloudflare Tunnel 的第三方服务，把你这台电脑临时暴露到公网，" +
      "好让对方用手机也能打开聊天窗口。它是免费的临时通道，随时可以关掉。\n" +
      "下面这段是技术细节，可以不看，但请你确认知道上面这句话的意思。\n",
  );
  console.log(
    "下一步会下载并运行第三方软件 cloudflared（Cloudflare, Inc. 发行）：\n" +
      `  版本与来源：${VERSION} ← ${downloadUrl()}\n` +
      "  用途：给本机 B 入口开一条临时公网地址，让 B 用自己手机访问（免账号 Quick Tunnel）\n" +
      "  会做什么：由本机主动向 Cloudflare 边缘建立出站连接；B 的请求与响应经这条连接转发\n" +
      "  不会做什么：不上传你的文件、不需要你登录 Cloudflare、不改动 ~/.cloudflared\n" +
      "  服务条款：https://www.cloudflare.com/website-terms/\n" +
      "  隐私政策：https://www.cloudflare.com/privacypolicy/\n" +
      "  功能文档：https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/\n",
  );
  if (!process.stdin.isTTY && !assumeYes) {
    // 不在这里偷偷放行：非交互环境要跑就得显式加 --yes，否则等于把 PRD §10.3 的确认环节跳过。
    // （注意判定顺序：--yes 本身就是“显式确认”，必须先看它，否则 CI / 管道里根本没法用，
    // 文案里那句「npm run e2e:tunnel 已自动加」会变成自己打自己的脸。）
    throw new Error(
      "非交互环境需要显式加 --yes 表示已看过条款（npm run e2e:tunnel 已自动加）",
    );
  }
  if (
    !assumeYes &&
    prior?.acceptedForVersion === VERSION &&
    prior?.downloadUrl === downloadUrl()
  ) {
    console.log(`[条款] 本机已在 ${prior.acceptedAt} 同意过同版本，继续`);
    return true;
  }
  if (assumeYes) {
    console.log(
      "[条款] --yes：视为已同意（上面这段条款原文已经打给用户，也写进 bin/third-party-terms.json 备查）",
    );
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      termsReceipt,
      `${JSON.stringify({ acceptedForVersion: VERSION, downloadUrl: downloadUrl(), acceptedAt: new Date().toISOString(), mode: "--yes" }, null, 2)}\n`,
    );
    return true;
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = (
    await rl.question(
      "同意下载并运行吗？输入 yes 继续，其它任何输入都会中止： ",
    )
  )
    .trim()
    .toLowerCase();
  rl.close();
  if (answer !== "yes") {
    console.log(
      "[条款] 未同意 → 不下载、不运行。想用隧道就手工安装 cloudflared（brew install cloudflared）；不想用就在 .env.example 填 PUBLIC_BASE_URL 走局域网。",
    );
    return false;
  }
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    termsReceipt,
    `${JSON.stringify({ acceptedForVersion: VERSION, downloadUrl: downloadUrl(), acceptedAt: new Date().toISOString(), mode: "interactive" }, null, 2)}\n`,
  );
  return true;
}

// .env.local 是「本机生成」的文件：本项目约定用户手填的值在 .env.example，
// 这里只写机器相关的一行，其它内容原样保留。
function writeEnvLocal(binaryPath) {
  let lines = [];
  if (fs.existsSync(envLocal)) {
    lines = fs.readFileSync(envLocal, "utf8").split(/\r?\n/);
  }
  const entry = `CLOUDFLARED_PATH=${binaryPath}`;
  const idx = lines.findIndex((l) => l.startsWith("CLOUDFLARED_PATH="));
  if (idx >= 0) {
    if (lines[idx] === entry) return false;
    lines[idx] = entry;
  } else {
    if (lines.length && lines[lines.length - 1] !== "") lines.push("");
    lines.push("# 由 npm run prepare-cloudflared 写入");
    lines.push(entry);
  }
  fs.writeFileSync(envLocal, `${lines.join("\n").replace(/\n+$/, "")}\n`);
  return true;
}

function download(url, dest) {
  // 用 curl -L 而不是 fetch：GitHub releases 会 302 到对象存储，
  // 公司网络/代理下 fetch 的报错信息比 curl 难懂得多。
  execFileSync(
    "curl",
    ["-fL", "--retry", "3", "--progress-bar", "-o", dest, url],
    { stdio: "inherit" },
  );
}

async function useExisting(binary, source) {
  const info = await verifyProvenance(binary, {
    enforcePinned: source !== "path",
  });
  writeManifest({
    path: binary,
    sha256: info.digest,
    source,
    checksPassed: info.checks,
  });
  console.log(
    `[cloudflared] 复核通过（${source}）：${binary}\n${info.versionText}`,
  );
  writeEnvLocal(binary);
  return { sha256: info.digest, version: info.versionText, checks: info.checks };
}

/**
 * 主流程。参数：
 *   assumeYes  非交互环境跳过条款询问（仍会把条款原文打出来）
 *   force      忽略 coding/bin 里已有的文件，重新下载
 * 返回值只描述「有没有准备好」，不抛业务异常以外的错误：条款没同意 → { ok:false, consent:"declined" }。
 */
export async function prepareCloudflared(options = {}) {
  noticeAboutUserConfig();

  const inPath = onPath();
  if (inPath) {
    // 用户自己装的（brew 等）：不去校验它的哈希（安装渠道不同，值本来就不该一样），
    // 但仍要求签名/版本对得上，别把一个假的 cloudflared 当真的跑起来。
    await useExisting(inPath, "path");
    console.log(`[cloudflared] 已在 PATH：${inPath}`);
    return;
  }

  const installed = options.force ?? cliOptions.force ? null : alreadyInstalled();
  if (installed) {
    const manifest = readManifest();
    if (manifest?.sha256 && manifest.path === installed) {
      console.log(`[cloudflared] 已存在，按清单复核：${installed}`);
    }
    await useExisting(installed, manifest?.source ?? "preexisting");
    return;
  }

  if (!(await confirmThirdParty(options))) return { ok: false, consent: "declined" };

  fs.mkdirSync(binDir, { recursive: true });
  const url = downloadUrl();
  // 先落到 .part：下载一半断掉、或者校验没过，都不会留下一个「看起来像是可用的二进制」。
  // 校验通过之后才改名生效（开发文档 §5.3 对下载路径的统一要求）。
  const archive = path.join(
    binDir,
    `cloudflared-download-${process.platform}.part`,
  );
  const unpackedPath = path.join(
    binDir,
    `cloudflared-unpacked-${process.pid}`,
  );
  const final = path.join(
    binDir,
    process.platform === "win32" ? "cloudflared.exe" : "cloudflared",
  );
  // --force 会跳过「已经装过就复用」那一步，直接到这里。原先那份可能是**能用的**，
  // 下载失败不能把它一起带走，否则「试一下换镜像」的代价是隧道直接挂掉。
  const backup = fs.existsSync(final) ? `${final}.previous-${process.pid}` : null;
  if (backup) fs.renameSync(final, backup);
  const restoreBackup = () => {
    if (backup && !fs.existsSync(final)) {
      try {
        fs.renameSync(backup, final);
        console.log("[cloudflared] 已把原来那份可用的装回去，这次失败没有让它消失");
      } catch {
        /* 还原失败就算了，下面还会报本次失败的原因 */
      }
    } else if (backup) {
      fs.rmSync(backup, { force: true });
    }
  };
  console.log(`[cloudflared] 下载 ${VERSION} → ${binDir}`);
  try {
    download(url, archive);

    if (process.platform === "darwin") {
      // macOS 发的是 tgz：先解到一个临时名字里，**校验过了**才搬到 final 上。
      const staging = path.join(binDir, `unpack-${process.pid}`);
      fs.mkdirSync(staging, { recursive: true });
      try {
        execFileSync("tar", ["xzf", archive, "-C", staging]);
        const unpacked = path.join(staging, path.basename(final));
        if (!fs.existsSync(unpacked)) {
          throw new Error(
            `解压后没找到 ${path.basename(final)}，请手工安装 cloudflared（brew install cloudflared）`,
          );
        }
        fs.copyFileSync(unpacked, unpackedPath);
      } finally {
        fs.rmSync(staging, { recursive: true, force: true });
      }
    } else {
      fs.copyFileSync(archive, unpackedPath); // Linux 是裸二进制，Windows 是 .exe
    }
    fs.chmodSync(unpackedPath, 0o755);
    // 签名/版本/哈希三道复核（PRD §13.1）：不过就绝不留下可执行文件。
    await verifyProvenance(unpackedPath, { enforcePinned: true });
    fs.renameSync(unpackedPath, final);
  } catch (err) {
    // 半途而废的东西一律不留：下载包、解出来一半的二进制都删掉，然后把旧的那份装回去。
    fs.rmSync(archive, { force: true });
    fs.rmSync(unpackedPath, { force: true });
    fs.rmSync(final, { force: true });
    restoreBackup();
    throw err;
  }
  fs.rmSync(archive, { force: true });
  if (backup) fs.rmSync(backup, { force: true });

  const info = await useExisting(final, "github-release");
  console.log(`[cloudflared] 就绪：${final}`);
  return { ok: true, path: final, source: "github-release", ...info };
}

/** CLI 入口：跑一遍流程，并把返回值翻译成退出码。 */
export async function main(argv = cliArgv) {
  const options = {
    assumeYes: argv.includes("--yes"),
    force: argv.includes("--force"),
    json: argv.includes("--json"),
  };
  const result = await prepareCloudflared(options);
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

if (isMainEntry()) {
  main().catch((err) => {
    reportFailure(err);
    process.exitCode = 1;
  });
}

/** 校验/下载失败的统一收口：说清「为什么宁可停下来也不跑它」，并给出三条出路。 */
function reportFailure(err) {
  const manual =
    process.platform === "darwin"
      ? "brew install cloudflared"
      : process.platform === "win32"
        ? "winget install --id Cloudflare.cloudflared"
        : "到 https://github.com/cloudflare/cloudflared/releases 下载后放进 coding/bin/cloudflared";
  console.error(`[cloudflared] 自动准备失败：${err.message}`);
  console.error(
    `[cloudflared] 这一步是刻意的：校验没过就绝不执行第三方二进制。手工安装：${manual}`,
  );
  console.error(
    `[cloudflared] 或者不用隧道：在 .env.example 里填 PUBLIC_BASE_URL，用局域网地址发给同网络的人。`,
  );
}

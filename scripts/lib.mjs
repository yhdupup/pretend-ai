// 阶段5 启动脚本的公共层（PRD §6.1 §12.2 §12.3 §20）。
//
// 结构约定（开发文档 §三）：
//   引导层  start-macos.command / start-windows.bat —— 不依赖 Node，只负责把项目专用 Node 弄出来；
//   准备层  scripts/*.mjs（本目录）—— 校验、装依赖、构建、起服务、停服务，全部可被 vitest 导入测试；
//   服务层  coding/dist/server/index.js —— 业务服务端，脚本不碰它的内部状态。
//
// 三条硬规矩，全套脚本都守：
// 1. 只用 Node 内置模块（node:fs / node:crypto / node:http…），脚本自己不能成为「需要先装东西才能跑」的东西；
// 2. 一切下载先落到 .part，SHA-256 对上才改名生效 —— 任何情况下都不执行、不加载未校验的字节；
// 3. 只在项目目录里写东西（.runtime / coding/node_modules / coding/dist / logs / data），
//    不碰 PATH、不碰注册表、不装服务、不写用户主目录。

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** 项目根（含 config/、.runtime/、两个 skill 目录和 coding/ 的那一层）。 */
export const REPO_ROOT = path.resolve(here, "..");
export const CODING_DIR = path.join(REPO_ROOT, "coding");
/**
 * RUNTIME_DIR / LOG_DIR / RUNTIME_MANIFEST 只给测试与 CI 用（开发文档 §5.13）：
 * 离线单测把它们指向临时目录，就不会碰真用户的东西。相对路径一律相对项目根解析，
 * 因为双击 .command 时的当前目录不一定是项目根。
 */
function resolveUnderRoot(value, fallback) {
  const raw = (value ?? "").trim() || fallback;
  return path.isAbsolute(raw)
    ? path.normalize(raw)
    : path.resolve(REPO_ROOT, raw);
}

export const RUNTIME_DIR = resolveUnderRoot(process.env.RUNTIME_DIR, ".runtime");
export const MANIFEST_PATH = resolveUnderRoot(
  process.env.RUNTIME_MANIFEST,
  "runtime-manifest.json",
);
export const LOG_DIR = resolveUnderRoot(process.env.LOG_DIR, "logs");
export const PID_FILE = path.join(RUNTIME_DIR, "server.pid");
export const LOCK_FILE = path.join(RUNTIME_DIR, "start.lock");

/** 退出码：脚本给终端用户看的，必须稳定（.command 的失败提示按码分支）。 */
export const EXIT = {
  OK: 0,
  /** 环境/清单/校验出问题，需要人看一眼 */
  ENV: 3,
  /** 端口被占用 */
  PORT: 4,
  /** 已经有一个实例在跑 */
  ALREADY_RUNNING: 5,
  /** 依赖安装或构建失败 */
  BUILD: 6,
  /** 网络下载失败 */
  NETWORK: 7,
  /** 不支持的平台 */
  PLATFORM: 8,
};

export function isMain(importMetaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  return samePath(fileURLToPath(importMetaUrl)) === samePath(path.resolve(entry));
}

/**
 * 比较两条路径是不是同一个文件。
 * 必须先 realpath：项目放在符号链接目录下（macOS 的 /tmp、Windows 的某些同步盘、
 * 或者用户自己建的软链）时，import.meta.url 是真实路径而 argv[1] 是链接路径，
 * 直接字符串比较会判成「不是主入口」，于是双击脚本一声不响地什么都不干 —— 最难查的那种 bug。
 */
function samePath(target) {
  let resolved = target;
  try {
    resolved = fs.realpathSync(resolved);
  } catch {
    /* 文件被删了之类的情况，用原样比较 */
  }
  resolved = path.normalize(resolved);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

// ---------- 平台与清单 ----------

/**
 * 当前平台在清单里的键。Windows 只有 x64 一种发布形态，macOS 分 arm64 / x64。
 * 测试和真机验证可用 AIWINDOW_FORCE_TARGET 假装成别的平台（只影响算路径和 URL，不会真下载）。
 */
export function platformTarget(env = process.env) {
  const forced = (env.AIWINDOW_FORCE_TARGET ?? "").trim();
  if (forced) return forced;
  const platform = { darwin: "darwin", win32: "win" }[process.platform];
  const arch = process.arch === "x64" ? "x64" : process.arch;
  const target = platform
    ? `${platform}-${arch}`
    : `${process.platform}-${arch}`;
  const supported = new Set(["darwin-arm64", "darwin-x64", "win-x64"]);
  if (!supported.has(target)) {
    const err = new Error(`PLATFORM_UNSUPPORTED: ${target}`);
    err.code = "PLATFORM_UNSUPPORTED";
    err.target = target;
    throw err;
  }
  return target;
}

export function isWindows(target = platformTarget()) {
  return target.startsWith("win");
}

/**
 * 读根目录的 runtime-manifest.json（钉死的版本 + 官方 SHA-256）。
 * 校验表由 coding/scripts/gen-runtime-manifest.mjs 从 nodejs.org 的 SHASUMS256.txt 生成，
 * 手填错一位 = 全机用户永久失败，所以这里对缺失/残缺一律硬报错，不做「那就跳过校验」的宽容。
 */
export function loadManifest(file = MANIFEST_PATH) {
  if (!fs.existsSync(file)) {
    const err = new Error(`RUNTIME_MANIFEST_MISSING: ${file}`);
    err.code = "RUNTIME_MANIFEST_MISSING";
    throw err;
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    const err = new Error(
      "RUNTIME_MANIFEST_INVALID: runtime-manifest.json 不是合法 JSON",
    );
    err.code = "RUNTIME_MANIFEST_INVALID";
    throw err;
  }
  const nodeVersion = raw?.node?.version ?? null;
  // 清单里写的是 v24.18.1；容忍有人手写成 24.18.1，统一补上 v 前缀再拼路径。
  const nodeTag = nodeVersion
    ? nodeVersion.startsWith("v")
      ? nodeVersion
      : `v${nodeVersion}`
    : null;
  const nodeTargets = raw?.node?.targets ?? {};
  const cloudflaredTargets = raw?.cloudflared?.targets ?? {};
  return {
    raw,
    nodeVersion,
    nodeTag,
    nodeChecksumHost: raw?.node?.checksumHost ?? "https://nodejs.org/dist",
    nodeMirrorBase: raw?.node?.mirrorBase ?? "https://nodejs.org/dist",
    nodeArchivePrefix: raw?.node?.archivePrefix ?? "node-v",
    nodeTargets,
    cloudflaredVersion: raw?.cloudflared?.version ?? null,
    cloudflaredReleaseUrl: raw?.cloudflared?.releaseUrl ?? null,
    cloudflaredTargets,
    paths: {
      runtimeDir: path.join(REPO_ROOT, raw?.paths?.runtimeDir ?? ".runtime"),
      nodeDir: raw?.paths?.nodeDir ?? ".runtime/node",
    },
  };
}

/** 清单里某个平台的 SHA-256；没钉 = 明确报错，不静默放行。 */
export function expectedChecksum(manifest, target, kind = "node") {
  const table =
    kind === "node" ? manifest.nodeTargets : manifest.cloudflareTargets;
  const entry = table?.[target];
  const sum = typeof entry === "string" ? entry : (entry?.sha256 ?? null);
  if (!sum) {
    const err = new Error(
      `RUNTIME_MANIFEST_INCOMPLETE: 清单里没有 ${target} 的 ${kind} 校验值`,
    );
    err.code = "RUNTIME_MANIFEST_INCOMPLETE";
    throw err;
  }
  // 长度不对 / 不全是十六进制 = 这一行是人手抄坏的。宁可现在拦下，
  // 也不能拿着半截哈希去比对（那等于把「校验失败」变成玄学）。
  if (!/^[0-9a-f]{64}$/i.test(String(sum))) {
    const err = new Error(
      `RUNTIME_MANIFEST_INVALID: ${kind} ${target} 的 sha256 不是 64 位十六进制，runtime-manifest.json 被改坏了`,
    );
    err.code = "RUNTIME_MANIFEST_INVALID";
    throw err;
  }
  return String(sum).toLowerCase();
}

/**
 * 本地假包闸门（开发文档 §5.3）：只有清单显式写了 "allowLocalFixture": true 才允许 file:// 源。
 */
export function allowsLocalFixture(manifest) {
  return manifest?.raw?.allowLocalFixture === true;
}

/** file:// 源没开闸门时报的错（统一形状，调用方按 code 分支）。 */
export function localFixtureNotAllowed(url) {
  const err = new Error(`LOCAL_FIXTURE_NOT_ALLOWED: ${url}`);
  err.code = "LOCAL_FIXTURE_NOT_ALLOWED";
  return err;
}

/** 下载源：清单给默认值，环境变量可换主机（镜像只换主机，SHA-256 一律不变）。 */
export function nodeArchiveName(manifest, target) {
  const ext = target.startsWith("win") ? "zip" : "tar.gz";
  return `node-${manifest.nodeTag}-${target}.${ext}`;
}

/** 下载 URL：镜像只换主机（AIWINDOW_NODE_BASE），文件名与校验值都还是官方那一套。 */
export function nodeArchiveUrl(manifest, target, env = process.env) {
  // 空字符串（.env 里写了 KEY= 但没填值）不算换镜像，否则拼出来的是个相对路径。
  const base =
    ((env.AIWINDOW_NODE_BASE ?? "").trim() || manifest.nodeMirrorBase).replace(
      /\/+$/,
      "",
    );
  return `${base}/${manifest.nodeTag}/${nodeArchiveName(manifest, target)}`;
}

export function cloudflaredUrl(manifest = loadManifest(), target, env = process.env) {
  const base = (env.AIWINDOW_TUNNEL_BASE ?? "").trim().replace(/\/+$/, "");
  const entry = manifest.cloudflareTargets?.[target];
  const name =
    entry?.artifact ??
    (target.startsWith("win")
      ? "cloudflared-windows-amd64.exe"
      : target === "darwin-arm64"
        ? "cloudflared-darwin-arm64.tgz"
        : "cloudflared-darwin-amd64.tgz");
  if (base) return `${base}/${name}`;
  const version = manifest.cloudflareVersion ?? "2025.4.2";
  const releaseBase = (
    manifest.cloudflareReleaseUrl ??
    "https://github.com/cloudflare/cloudflared/releases/download"
  ).replace(/\/+$/, "");
  const tag = version.startsWith("v") ? version : `v${version}`;
  return `${releaseBase}/${tag}/${name}`;
}

/** 项目专用 Node 的落点：.runtime/node/<固定版本>/<平台>[/bin] */
export function nodeHome(
  target,
  version = manifestVersion(),
  root = REPO_ROOT,
) {
  const tag = String(version).startsWith("v") ? version : `v${version}`;
  return path.join(root, ".runtime", "node", tag, target);
}

function manifestVersion() {
  try {
    return loadManifest().nodeTag ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** 一个 node home 目录里的可执行文件位置（mac 在 bin/ 下，win 就在根上）。 */
export function nodeExePath(home, target = platformTarget()) {
  return target.startsWith("win")
    ? path.join(home, "node.exe")
    : path.join(home, "bin", "node");
}

export function nodeExecutable(
  target = platformTarget(),
  manifest = null,
  root = REPO_ROOT,
) {
  manifest = manifest ?? loadManifest();
  const home = nodeHome(target, manifest.nodeTag, root);
  return nodeExePath(home, target);
}

/** 用项目专用 Node 时的 PATH 前缀（npm/npx 在同一个目录里）。 */
export function nodeBinDir(
  target = platformTarget(),
  manifest = null,
  root = REPO_ROOT,
) {
  manifest = manifest ?? loadManifest();
  const home = nodeHome(target, manifest.nodeTag, root);
  return target.startsWith("win") ? home : path.join(home, "bin");
}

// ---------- 环境变量（与 coding/src/server/config.ts 的优先级保持一致）----------

function parseEnvText(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) out[key] = value;
  }
  return out;
}

/**
 * 脚本层要读的两个键（端口）用与服务端相同的优先级解析：
 * shell 环境 > .env.local > .env.example > 默认值。
 * 不一致的话会出现「脚本探测 A 端口，服务端监听 B 端口」这种玄学故障。
 */
export function resolveEnv(name, fallback, root = REPO_ROOT) {
  if (process.env[name]) return process.env[name];
  for (const file of [".env.local", ".env.example"]) {
    const target = path.join(root, file);
    if (!fs.existsSync(target)) continue;
    const value = parseEnvText(fs.readFileSync(target, "utf8"))[name];
    if (value) return value;
  }
  return String(fallback);
}

export function resolvePort(name, fallback, root = REPO_ROOT) {
  const parsed = Number.parseInt(resolveEnv(name, fallback, root), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// ---------- 校验 / 下载 / 解压 ----------

export function sha256File(file) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

/** 流式下载到一个文件（不缓冲到内存：Node 包 40~50MB）。 */
export function downloadFile(
  url,
  dest,
  {
    timeoutMs = 300_000,
    maxRedirects = 5,
    stallMs = 30_000,
    onProgress = null,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const sink = fs.createWriteStream(dest);
    const get = url.startsWith("https:") ? https.get : http.get;
    let settled = false;
    let bytes = 0;
    let total = 0;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      sink.destroy();
      if (err) reject(err);
    };
    const request = (target) => {
      const req = get(target, { timeout: Math.min(stallMs, timeoutMs) }, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (maxRedirects <= 0) return finish(new Error("NETWORK_REDIRECT_LOOP"));
          maxRedirects -= 1;
          return request(new URL(res.headers.location, target).toString());
        }
        if (status !== 200) return finish(new Error(`NETWORK_HTTP_${status}`));
        total = Number(res.headers["content-length"]) || 0;
        // 进度回调不能把下载弄崩：打印失败顶多就是没进度，不能让启动死在这。
        res.on("data", (chunk) => {
          bytes += chunk.length;
          if (onProgress) {
            try {
              onProgress(bytes, total);
            } catch {
              /* 忽略 */
            }
          }
        });
        res.pipe(sink);
        sink.on("finish", () => {
          if (settled) return;
          settled = true;
          sink.close(() => resolve(dest));
        });
        sink.on("error", finish);
      });
      req.on("timeout", () => {
        // socket 多久没动静算卡住。总时长不设限：慢但一直在流的下载对用户是成功的。
        req.destroy(new Error("NETWORK_STALLED"));
      });
      req.on("error", (err) => {
        finish(
          err?.message === "NETWORK_STALLED"
            ? Object.assign(new Error(`NETWORK_STALLED 下载卡住超过 ${Math.round(stallMs / 1000)} 秒`), {
                code: "NETWORK_STALLED",
                bytes,
              })
            : err,
        );
      });
    };
    request(url);
  });
}

/**
 * 下载 → 校验 → 才改名生效。校验不过：删 .part、抛错、绝不执行。
 * file:// 源只给测试用，而且要求清单显式写了 allowLocalFixture: true（开发文档 §5.3）：
 * 真实发布清单里永远没有这个键，所以用户机器上「从本地文件拿运行时」这条路是死的。
 */
/**
 * 下载进度打印器。
 *
 * 为什么非要有：实测从 nodejs.org 直连拉 Node 包，慢的时候五分铻才完，窗口上一直只有
 * 「正在下载」四个字——用户无法区分「在慢慢下」和「卡死了」，只会强退（然启开始怀疑项目）。
 * 同一条行刷百分比与速率，至少能让人知道它还在动。默认 5 秒刷一次，收尾一定换行，
 * 免得后面的日志接在半行后面。测到卡住（NETWORK_STALLED）时，那句「下载卡住」得自己补一句镜像提示。
 */
export function makeProgressPrinter({
  label = "下载",
  everyMs = 5_000,
  write = null,
  tty = Boolean(process.stderr.isTTY),
} = {}) {
  // 走 stderr：stdout 留给状态行，被别的脚本读的时候不能被进度污染。
  const out = write ?? ((line) => process.stderr.write(line));
  const started = Date.now();
  let last = 0;
  let lastPct = -1;
  return (got, total) => {
    const now = Date.now();
    const pct = total > 0 ? Math.floor((got / total) * 100) : -1;
    const done = pct === 100 || (total > 0 && got >= total);
    if (!done && now - last < everyMs && pct !== lastPct) return;
    last = now;
    lastPct = pct;
    const mb = (got / 1024 / 1024).toFixed(1);
    const speed = got / Math.max(1, (now - started) / 1000) / 1024;
    const size = total > 0 ? ` / ${(total / 1024 / 1024).toFixed(1)} MB` : "";
    const pctText = total > 0 ? ` ${pct}%` : "";
    const line = `${label}：${mb} MB${size}${pctText}（约 ${speed.toFixed(0)} KB/s）`;
    // 终端里刷同一行（不堆 60 行进度）；写进日志/管道时每行一条，事后能回看速度。
    out(tty && !done ? `\r    ${line} ` : `    ${line}\n`);
  };
}

export async function downloadAndVerify(
  url,
  dest,
  sha256,
  { localFixture = false, onProgress = null, stallMs = 30_000 } = {},
) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (url.startsWith("file://") && !localFixture) {
    throw localFixtureNotAllowed(url);
  }
  const part = `${dest}.part`;
  fs.rmSync(part, { force: true });
  try {
    if (url.startsWith("file://")) {
      fs.copyFileSync(fileURLToPath(url), part);
      onProgress?.(fs.statSync(part).size, fs.statSync(part).size);
    } else {
      await downloadFile(url, part, { onProgress, stallMs });
    }
    const actual = sha256File(part);
    if (actual !== String(sha256).toLowerCase()) {
      fs.rmSync(part, { force: true });
      const err = new Error(
        `CHECKSUM_MISMATCH expected=${sha256} actual=${actual}`,
      );
      err.code = "CHECKSUM_MISMATCH";
      throw err;
    }
    fs.renameSync(part, dest);
    return dest;
  } catch (err) {
    fs.rmSync(part, { force: true });
    throw err;
  }
}

/** 解压到 dest（内部会先清空 dest，重复安装是幂等的）。 */
export function extractArchive(archive, dest, { strip = 1 } = {}) {
  fs.mkdirSync(dest, { recursive: true });
  // tar 在 macOS 是系统自带，在 Windows 10+ 也是自带的 bsdtar（它也认 zip）—— 两边一条路走。
  const args = [
    "-xf",
    archive,
    "-C",
    dest,
    "--strip-components",
    String(strip),
  ];
  const result = spawnSync("tar", args, { stdio: "inherit" });
  if (result.status !== 0) {
    const err = new Error(`EXTRACT_FAILED exit=${result.status}`);
    err.code = "EXTRACT_FAILED";
    throw err;
  }
  return dest;
}

// ---------- 安装/构建标记 ----------

/** 内容指纹：只用于「该不该重装 / 该不该重建」，不用于任何安全判断。 */
export function fingerprint(files, root = CODING_DIR) {
  const hash = crypto.createHash("sha256");
  for (const rel of files) {
    const abs = path.join(root, rel);
    hash.update(`${rel}\u0000`);
    try {
      const st = fs.statSync(abs);
      // 只记大小与内容，故意不记 mtime：git checkout / 拷贝目录都会刷新时间戳，
      // 把 mtime 算进指纹等于「每次拉代码都重装依赖 + 重建」。
      hash.update(`${st.size}\u0000`);
      if (st.isFile()) hash.update(fs.readFileSync(abs));
      else hash.update("<dir>\u0000");
    } catch {
      hash.update("missing\u0000");
    }
  }
  return hash.digest("hex");
}

/** JSON 稳定序列化：键排序，数组保持原序（依赖列表的顺序不影响装出来的东西，但别乱动语义）。 */
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
    .join(",")}}`;
}

// 只有这些字段会改变「装出来的 node_modules 长什么样」。
const DEPS_RELEVANT_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "overrides",
  "resolutions",
  "workspaces",
  "bin",
  "engines",
  "os",
  "cpu",
];

/**
 * 依赖指纹：只哈希会影响安装结果的部分。
 *
 * 为什么不干脆整份 package.json 进哈希（一开始就是这么写的）：改一个 npm script 的名字、
 * 加一句 description，都会被判成「依赖变了」而重装一遍 —— 阶段5 实测踩到：往 package.json
 * 加 `e2e:startup` 之后，下一次启动白白跑了一次完整安装。对第一次双击的 A 来说，
 * 那意味着多等几分钟和一句莫名其妙的「正在安装依赖」。
 * lock 文件仍然全量参与：它才是决定装哪些版本的那份清单。
 */
export function depsFingerprint(codingDir = CODING_DIR) {
  const hash = crypto.createHash("sha256");
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(codingDir, "package.json"), "utf8"),
    );
    const picked = {};
    for (const key of DEPS_RELEVANT_FIELDS) {
      if (pkg[key] !== undefined) picked[key] = pkg[key];
    }
    hash.update(`package.json\u0000${stableStringify(picked)}\u0000`);
  } catch {
    hash.update("package.json\u0000missing\u0000");
  }
  try {
    hash
      .update("package-lock.json\u0000")
      .update(fs.readFileSync(path.join(codingDir, "package-lock.json")));
  } catch {
    hash.update("package-lock.json\u0000missing\u0000");
  }
  return hash.digest("hex");
}

export function stampFile(name, runtimeDir = RUNTIME_DIR) {
  return path.join(runtimeDir, `${name}.stamp.json`);
}

export function readStamp(name, runtimeDir = RUNTIME_DIR) {
  const file = stampFile(name, runtimeDir);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function writeStamp(name, value, runtimeDir = RUNTIME_DIR) {
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(
    stampFile(name, runtimeDir),
    JSON.stringify({ ...value, writtenAt: new Date().toISOString() }, null, 2),
  );
}

// ---------- 输出 ----------

const STATE_TEXT = {
  CHECKING_PLATFORM: "检查系统",
  CHECKING_RUNTIME: "检查运行环境",
  DOWNLOADING_NODE: "下载 Node 运行环境",
  VERIFYING_NODE: "校验运行环境",
  CHECKING_CLOUDFLARED: "准备公网通道组件",
  DOWNLOADING_CLOUDFLARED: "下载公网通道组件",
  NEEDS_CONSENT_CLOUDFLARED: "需要你的同意",
  CHECKING_DEPS: "安装依赖",
  BUILDING: "构建界面",
  CHECKING_PORT: "检查端口",
  CHECKING_INSTANCE: "检查是否已有实例",
  STARTING_CORE: "启动本地服务",
  HEALTH_CHECKING: "等待服务就绪",
  OPENING_BROWSER: "打开工作台",
  WAITING: "运行中",
  STOPPING: "正在停止",
  READY: "已就绪",
  DONE: "完成",
};

export function step(state, extra = "") {
  const label = STATE_TEXT[state] ?? state;
  process.stdout.write(`[${label}]${extra ? ` ${extra}` : ""}\n`);
}

export function detail(text) {
  process.stdout.write(`    ${text}\n`);
}

export function die(code, message, hint = "", label = "启动失败") {
  // 阶段5：stop.mjs 也走这里，写死「启动失败」会让用户以为双击了停止却把服务弄坏了。
  process.stderr.write(`\n${label}：${message}\n`);
  if (hint) process.stderr.write(`怎么办：${hint}\n`);
  return code;
}

/**
 * 这个 PID 此刻到底还在不在。
 * process.kill(pid, 0) 不发信号，只探活：ESRCH = 没这个进程，EPERM = 有但不是我的。
 */
export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

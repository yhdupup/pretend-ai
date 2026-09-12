import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Hono } from "hono";
import type { Context } from "hono";
import { config } from "../../config.js";
import { isUsingEnvControlToken } from "../../security/control-token.js";
import {
  getSkillRegistry,
  type LoadedSkill,
} from "../../../assist/skills/loader.js";

// 阶段5：本机自检台（验收 / 排障用的一页纸）。
//
// 组成：
// - GET /selftest            页面本体（静态 HTML，免 Cookie：它自己会去请求需要 Cookie 的接口，
//                            没登录时页面会明确显示「请先用启动器打开的工作台链接换会话」）；
// - GET /api/local/selftest/*  自检数据（走正常鉴权，只存在于 A 入口）。
//
// 为什么单独做这个：阶段5 的验收项一半是脚本层行为（端口、实例、令牌、构建产物、Skill 装载、
// 隧道状态），以前只能靠读代码或跑 vitest 才能确认。给 A 一页能点的东西，她自己就能判「这台机器
// 到底准备好了没有」。它不替代自动化测试，只是把已有事实汇总显示。
//
// 隐私边界：这里回的全是**本机运行环境与状态**，不含会话正文、不含任何令牌值、不含模型密钥。
// 判断依据：字段全部在本文件里手写死，没有任何一处是 `{...config}` 之类的整体转储。
// 第三方条款确认不在这里做 —— 启动脚本首次下载 cloudflared 时已经问过（PRD §13.2），
// 本端点只报「用的哪个版本、清单里有没有这个平台」。

const PAGE_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  // 页面自带样式与脚本，不引任何外部资源；connect-src 只允许同源（就是本入口）。
  "content-security-policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
};

export function renderSelftestPage(c: Context): Response {
  const file = path.resolve(config.selftestHtmlPath);
  if (!fs.existsSync(file)) {
    return c.html(
      `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>自检台未就绪</title>` +
        `<p style="font:14px/1.6 system-ui;padding:24px">找不到自检页文件：<code>${file}</code>。</p>` +
        `<p style="font:14px/1.6 system-ui;padding:0 24px">它随项目分发，缺失时请重新获取项目目录。</p></html>`,
      503,
      PAGE_HEADERS,
    );
  }
  return c.html(fs.readFileSync(file, "utf8"), 200, PAGE_HEADERS);
}

function readManifest(): {
  present: boolean;
  nodeVersion?: string;
  cloudflaredVersion?: string;
  target?: string;
  targetPinned?: boolean;
} {
  const file = path.join(config.projectRoot, "runtime-manifest.json");
  if (!fs.existsSync(file)) return { present: false };
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
      node?: { version?: string };
      cloudflared?: { version?: string };
      targets?: Record<string, unknown>;
      nodeTargets?: Record<string, unknown>;
    };
    const target = `${process.platform}-${process.arch === "x64" ? "x64" : process.arch}`;
    const nodeTargets = raw.nodeTargets ?? raw.targets ?? {};
    return {
      present: true,
      nodeVersion: raw.node?.version,
      cloudflaredVersion: raw.cloudflared?.version,
      target,
      targetPinned: Boolean(
        (nodeTargets as Record<string, unknown>)[target] ??
        (nodeTargets as Record<string, unknown>)[
          target === "darwin-x64" ? "darwin-amd64" : target
        ],
      ),
    };
  } catch {
    return { present: true, nodeVersion: undefined };
  }
}

const app = new Hono();

/**
 * 让 A 的服务端自己去探 B 入口 —— 不是「图省事」，是浏览器根本做不到。
 *
 * 页面原先直接在 A 的上下文里 fetch http://127.0.0.1:8788/...，看着合理，实际必然失败：
 * 端口不同就是不同源，B 入口又不发任何 CORS 头（它面向公网，本来就不该为控制台开 CORS）。
 * 本机 Chrome 实测：连 no-cors 也拿不到状态，只会得到一个 opaque 响应，页面上永远显示失败。
 * 要么给公网入口加 CORS —— 为了一个自检页面去扩大公网面，不值；
 * 要么由 A 进程本机回环探一下，把结论放进这个已经是 Cookie 保护的接口里。选了后者。
 *
 * 探针带随机串并要求原样回显：只看 200 会误判（缓存、代理、上一轮残留实例都能给你 200）。
 */
async function probePublicEntry(): Promise<Record<string, unknown>> {
  const probeValue = "selftest" + Math.random().toString(36).slice(2, 10);
  const url = `http://127.0.0.1:${config.publicPort}/api/public/health?probe=${probeValue}`;
  const started = Date.now();
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(2_000),
      // 本机回环：明确绕过任何代理设置，别把「本机代理没配好」当成「B 入口挂了」。
      cache: "no-store",
    } as RequestInit);
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    // 顺手替页面问一句「B 端口上有没有 A 的控制接口」。这一问也必须在服务端做：
    // 自检页的 CSP 是 connect-src 'self'，浏览器根本不允许这个页面去连 8788 ——
    // 那正是我们想要的隔离，但也意味着页面里写 cross-port fetch 的检查永远只会得到 Failed to fetch。
    let localRouteStatus: number | null = null;
    try {
      const leaky = await fetch(
        `http://127.0.0.1:${config.publicPort}/api/local/health?probe=${probeValue}`,
        { signal: AbortSignal.timeout(2_000), cache: "no-store" } as RequestInit,
      );
      localRouteStatus = leaky.status;
    } catch {
      localRouteStatus = null;
    }
    return {
      reachable: res.status === 200 && body.ok === true,
      status: res.status,
      localRouteStatus,
      service: body.service ?? null,
      // 回显对得上才算「真的是我们在跑的那个 B」，而不是一路某个替我们答 200 的东西。
      probeEchoed: body.probe === probeValue,
      latencyMs: Date.now() - started,
      port: config.publicPort,
    };
  } catch (err) {
    // 字段永远在、只是 null：前端拿到的形状不该随探测成败而变，
    // 否则页面必须写两套判空逻辑，而「写漏一边」正是这类代码最常见的坏法。
    return {
      reachable: false,
      localRouteStatus: null,
      error: (err as Error).name === "TimeoutError" ? "TIMEOUT" : "UNREACHABLE",
      port: config.publicPort,
      latencyMs: Date.now() - started,
    };
  }
}

/** 本机有没有真的在跑 cloudflared（B 链接是真隧道还是局域网回退，靠这个区分）。 */
function tunnelProcessFacts(): Record<string, unknown> {
  const probeBin = path.join(config.projectRoot, "coding", "bin", "cloudflared");
  return {
    binaryPresent: fs.existsSync(probeBin),
    // 进程探测只在类 Unix 上做：Windows 上这条由页面里的手工清单承担，
    // 不值得为了一个显示项在请求路径里起 PowerShell。
    running:
      process.platform === "win32"
        ? null
        : (() => {
            try {
              const r = spawnSync("pgrep", ["-f", "cloudflared"], {
                encoding: "utf8",
                timeout: 2_000,
              });
              return r.status === 0 && String(r.stdout).trim().length > 0;
            } catch {
              return null;
            }
          })(),
  };
}

function readJsonSafe(file: string): Record<string, any> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, any>;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 启动脚本那一层才知道的事实（页面上那些「本机环境」「启动层」检查全靠它）。
 *
 * 为什么服务端自已算：这些数据在 `.runtime/` 与 `logs/` 里，而页面只能同源 fetch；
 * 让 A 自已开终端去 `cat` 一个 stamp 文件，不叫验收，叫作业。
 *
 * 隐私：只回「命中个数」与文件名，**不回日志内容**；哈希只给前 12 位（那是公开二进制的校验值，
 * 不是秘密，但没必要把全文堆到一个 JSON 里）。绝不回令牌、绝不回密钥。
 */
function launcherFacts(): Record<string, unknown> {
  const root = config.projectRoot;
  const runtimeDir = path.join(
    root,
    (process.env.RUNTIME_DIR ?? "").trim() || ".runtime",
  );
  const logsDir = path.join(root, (process.env.LOG_DIR ?? "").trim() || "logs");
  const rel = (p: string) => path.relative(root, p).split(path.sep).join("/");

  const pidFile = path.join(runtimeDir, "server.pid");
  // ⚠️ 这个文件写的是一整个 JSON（pid / nodeExe / startedAt / ports / entry），
  // 不是裸数字 —— 按 Number(整个文件内容) 去读会得到 NaN，于是自检台报
  // 「server.pid 里是 null，进程已不存在」，把一次正常的启动说成了一次残留。
  const pidJson = readJsonSafe(pidFile);
  const pid = Number.isFinite(Number(pidJson?.pid)) ? Number(pidJson!.pid) : null;

  const logNames = fs.existsSync(logsDir)
    ? fs
        .readdirSync(logsDir)
        .filter((f) => /^run-.*\.log$/.test(f))
        .sort()
        .reverse()
    : [];
  let tokenHits = 0;
  let absolutePathHits = 0;
  for (const f of logNames.slice(0, 5)) {
    let text = "";
    try {
      text = fs.readFileSync(path.join(logsDir, f), "utf8");
    } catch {
      continue;
    }
    tokenHits += (text.match(/\b[0-9a-f]{64}\b/g) ?? []).length;
    absolutePathHits += (
      text.match(/\/Users\/|\/home\/[a-z0-9._-]+\/|[A-Za-z]:\\Users\\/gi) ?? []
    ).length;
  }

  const nodeRoot = path.join(runtimeDir, "node");
  const nodeVersions = fs.existsSync(nodeRoot)
    ? fs.readdirSync(nodeRoot).filter((f) => /^v?\d+/.test(f))
    : [];
  const receipt = readJsonSafe(path.join(root, "coding", "bin", "cloudflared-receipt.json"));
  const manifest = readJsonSafe(path.join(root, "runtime-manifest.json"));
  const deps = readJsonSafe(path.join(runtimeDir, "deps.stamp.json"));
  const build = readJsonSafe(path.join(runtimeDir, "build.stamp.json"));

  return {
    runtimeDir: rel(runtimeDir),
    pidFile: {
      exists: pid !== null,
      pid,
      // 三者对得上，才能说「pid 文件没在说谎」。
      pointsAtThisProcess: pid !== null && pid === process.pid,
      processAlive: pid !== null && alive(pid),
      // 端口对不上 = 这份 pid 是别的端口配置下留下的，值得一眼看见。
      portsMatch:
        pidJson?.ports?.local === undefined
          ? null
          : pidJson.ports.local === config.localPort &&
            pidJson.ports.public === config.publicPort,
    },
    lockFileExists: fs.existsSync(path.join(runtimeDir, "start.lock")),
    // 启动器给的令牌（只报布尔，不报值）：这一项为 true 才说明是双击启动而不是 `npm run dev`。
    launcherSuppliedToken: isUsingEnvControlToken(),
    projectRuntime: {
      installed: nodeVersions.length > 0,
      versions: nodeVersions,
      // 跑着的这个进程到底是不是项目自带的那份（看 execPath 落在哪儿）。
      inUse: process.execPath.includes(`${path.sep}.runtime${path.sep}`),
    },
    stamps: {
      deps: deps
        ? {
            writtenAt: deps.writtenAt ?? null,
            nodeVersion: deps.nodeVersion ?? null,
            // stamp 是别的机器/别的 Node 写的话，下次启动会重装（阶段五设计如此）。
            matchesThisMachine:
              deps.nodeVersion === process.version &&
              deps.platform === process.platform &&
              deps.arch === process.arch,
          }
        : null,
      build: build ? { writtenAt: build.writtenAt ?? null } : null,
    },
    logs: {
      count: logNames.length,
      newest: logNames[0] ?? null,
      keptMax: 5,
      tokenHexHits: tokenHits,
      absolutePathHits,
    },
    tunnel: receipt
      ? {
          version: receipt.version ?? null,
          target: receipt.target ?? null,
          source: receipt.source ?? null,
          checksPassed: receipt.checksPassed ?? [],
          sha256Prefix: String(receipt.sha256 ?? "").slice(0, 12),
          matchesManifest:
            !manifest?.cloudflared?.version ||
            receipt.version === manifest.cloudflared.version,
        }
      : null,
  };
}

// 运行环境：谁在跑、跑在哪、用哪套产物。
app.get("/env", async (c) => {
  const manifest = readManifest();
  const [publicProbe, tunnelProcess] = await Promise.all([
    probePublicEntry(),
    Promise.resolve(tunnelProcessFacts()),
  ]);
  return c.json({
    publicProbe,
    tunnelProcess,
    ok: true,
    runtime: {
      nodeVersion: process.version,
      execPath: process.execPath,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      // 从项目专用 Node 启动时 execPath 会落在 .runtime 里 —— 自检页靠这一眼就能看出「用的不是系统 Node」。
      usingProjectRuntime: process.execPath.includes(
        `${path.sep}.runtime${path.sep}`,
      ),
      uptimeSeconds: Math.round(process.uptime()),
      nodeEnv: config.nodeEnv,
      // 只报「是不是启动器给的令牌」，绝不报令牌本身。
      launcherSuppliedToken: isUsingEnvControlToken(),
      hostname: os.hostname(),
    },
    paths: {
      cwd: process.cwd(),
      projectRoot: config.projectRoot,
      aDist: path.resolve(config.aFrontendDistPath),
      aDistExists: fs.existsSync(
        path.join(path.resolve(config.aFrontendDistPath), "index.html"),
      ),
      bDist: path.resolve(config.bFrontendDistPath),
      bDistExists: fs.existsSync(
        path.join(path.resolve(config.bFrontendDistPath), "index.html"),
      ),
      dataPath: path.resolve(config.localDataPath),
      dataExists: fs.existsSync(path.resolve(config.localDataPath)),
      envExample: fs.existsSync(path.join(config.projectRoot, ".env.example")),
      envLocal: fs.existsSync(path.join(config.projectRoot, ".env.local")),
      skillsConfig: fs.existsSync(
        path.join(config.projectRoot, "config", "skills.json"),
      ),
    },
    manifest,
    launcher: launcherFacts(),
    ports: {
      local: config.localPort,
      public: config.publicPort,
      localHost: config.localHost,
      publicHost: config.publicHost,
    },
    skills: (() => {
      const reg = getSkillRegistry();
      const pick = (skill: LoadedSkill) => ({
        configuredPath: skill.configuredPath,
        status: skill.status,
        usable: skill.usable,
        skillId: skill.skillId,
        skillVersion: skill.skillVersion,
        // 哈希只给前 8 位：够 A 核对「我改过 Skill 但没重启」，又不把内部标识当正文展示。
        hashPrefix: skill.contentHash ? skill.contentHash.slice(0, 8) : null,
        // reason 本来就是「给 A 看的中文原因」，阶段4 已保证不含文件内容与绝对路径。
        reason: skill.reason,
      });
      return {
        aiStyle: pick(reg.aiStyle),
        analysis: pick(reg.analysis),
        configError: reg.configError,
      };
    })(),
  });
});

export default app;

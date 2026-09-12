import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import fs from "node:fs";
import path from "node:path";

// 阶段3：隧道进程提供者（PRD §10.2）。
//
// P0 = 内置 cloudflared Quick Tunnel（免注册、随机域名、无 SLA）。
// P1 = 用户自备命令（PUBLIC_TUNNEL_COMMAND）：任何"把 URL 打到 stdout/stderr"的命令都能接。
//
// 本文件只负责“起进程 + 从输出里抠出公网地址”，状态机、重连、失效清理都在 manager.ts。

/** 找不到隧道客户端时抛这个，好让上层给出可操作的中文提示。 */
export class TunnelClientMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TunnelClientMissingError";
  }
}

export interface TunnelProcess {
  readonly kind: TunnelProviderKind;
  /** 解析到公网地址（已去尾斜杠）时 resolve；进程先退出或超时则 reject。 */
  readonly url: Promise<string>;
  /** 进程退出时 resolve；正常停止也会走到这里。 */
  readonly exited: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>;
  stop(): void;
}

export type TunnelProviderKind = "cloudflared" | "command";

export interface ProviderOptions {
  kind: TunnelProviderKind;
  command: string;
  args: string[];
  /** 从一行输出里提取 URL；返回 null 表示这行没有。 */
  parseUrl(line: string): string | null;
  connectTimeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

const CLOUDFLARED_URL_RE = /https:\/\/[a-z0-9.-]+\.trycloudflare\.com/i;
// Quick Tunnel 的创建接口会被限流（429 / error code 1015）。这个必须单独认出来：
// 限流时立刻重连只会让封禁更久，正确做法是停下来等一分钟再点。阶段3 自测就是连开十几条隧道踩到的。
const CLOUDFLARED_RATE_LIMIT_RE =
  /error code: 1015|too many requests|rate.?limit/i;
// 自备命令没给正则时，退到通用抓取：抓第一个看起来像 URL 的串。
const GENERIC_URL_RE = /https?:\/\/[a-z0-9._~-]+(?::\d+)?(?:\/[^\s"']*)?/i;

/**
 * 从一行输出里提取公网地址。
 * 自备命令可用 PUBLIC_URL_REGEX 指定一个带捕获组的正则（优先取捕获组，其次整段匹配）。
 */
export function makeUrlParser(
  kind: TunnelProviderKind,
  customPattern: string,
  allowInsecure = false,
) {
  let custom: RegExp | null = null;
  if (customPattern) {
    try {
      custom = new RegExp(customPattern, "i");
    } catch {
      custom = null; // 正则写错就退回默认抓取，不让隧道因此起不来
    }
  }
  return (line: string): string | null => {
    let candidate: string | null = null;
    if (custom) {
      const m = custom.exec(line);
      candidate = m ? (m[1] ?? m[0]) : null;
    } else if (kind === "cloudflared") {
      const m = CLOUDFLARED_URL_RE.exec(line);
      candidate = m ? m[0] : null;
    } else {
      const m = GENERIC_URL_RE.exec(line);
      candidate = m ? m[0] : null;
    }
    if (!candidate) return null;
    candidate = candidate.replace(/\/+$/, "");
    if (!allowInsecure && !candidate.startsWith("https://")) return null;
    return candidate;
  };
}

/**
 * 定位 cloudflared 可执行文件。顺序：显式配置 → 项目内 ./bin → PATH。
 * 不做自动下载：PRD §10.3 要求首次下载第三方客户端前必须由 A 明确确认，
 * 所以下载与校验放在 scripts/prepare-cloudflared.mjs，由人跑一次。
 */
export function resolveCloudflaredPath(
  configured: string,
  cwd = process.cwd(),
): string {
  const exe = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
  const candidates = [
    configured,
    path.resolve(cwd, "bin", exe),
    path.resolve(cwd, "..", "bin", exe),
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  // PATH 里找（不引 cross-spawn 之类的额外依赖，自己拆 PATH）
  const ext =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
      : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const suffix of ext) {
      const full = path.join(dir, exe + suffix.toLowerCase());
      if (fs.existsSync(full)) return full;
    }
  }
  throw new TunnelClientMissingError(
    `找不到 cloudflared。请先跑 node scripts/prepare-cloudflared.mjs 装进 ${path.join("bin", exe)}，` +
      `或把 CLOUDFLARED_PATH 指到已有二进制，或改用 PUBLIC_TUNNEL_COMMAND 自备隧道。`,
  );
}

/** 真正起一个隧道子进程。抽成独立函数，方便测试里换假实现。 */
export function startTunnelProcess(opts: ProviderOptions): TunnelProcess {
  const child: ChildProcessByStdio<null, Readable, Readable> = spawn(
    opts.command,
    opts.args,
    {
      cwd: opts.cwd ?? process.cwd(),
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const parse = opts.parseUrl;

  let resolved = false;
  let settleUrl: (v: string) => void = () => {};
  let rejectUrl: (e: Error) => void = () => {};
  const url = new Promise<string>((resolve, reject) => {
    settleUrl = resolve;
    rejectUrl = reject;
  });

  let settleExit: (v: {
    code: number | null;
    signal: NodeJS.Signals | null;
  }) => void = () => {};
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    settleExit = resolve;
  });

  let rateLimited = false;
  const handleLine = (chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) {
      if (!line) continue;
      // 只做个布尔判定，不把 stderr 内容原样带出去（第三方输出里可能含地址，PRD §18.6）
      if (opts.kind === "cloudflared" && CLOUDFLARED_RATE_LIMIT_RE.test(line))
        rateLimited = true;
      const found = parse(line);
      if (found && !resolved) {
        resolved = true;
        settleUrl(found);
      }
    }
  };

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", handleLine);
  child.stderr.on("data", handleLine);

  const timeout = setTimeout(() => {
    if (!resolved) {
      rejectUrl(
        new Error(
          `TUNNEL_CONNECT_TIMEOUT：${opts.connectTimeoutMs ?? 0}ms 内没等到公网地址`,
        ),
      );
    }
  }, opts.connectTimeoutMs ?? 45_000);
  timeout.unref?.();

  child.on("error", (err) => {
    // ENOENT 之类：进程根本没起来，url 必须先失败，否则上层会挂在 connectTimeout 上
    if (!resolved) rejectUrl(new Error(`TUNNEL_SPAWN_FAILED：${err.message}`));
  });

  child.on("exit", (code, signal) => {
    clearTimeout(timeout);
    if (!resolved) {
      rejectUrl(
        new Error(
          rateLimited
            ? "TUNNEL_RATE_LIMITED：Cloudflare 暂时限流了公网地址创建接口"
            : `TUNNEL_EXITED_EARLY：隧道进程提前退出（code=${code ?? signal}）`,
        ),
      );
    }
    settleExit({ code, signal });
  });

  return {
    kind: opts.kind,
    url,
    exited,
    stop() {
      if (!child.killed) child.kill("SIGTERM");
    },
  };
}

export interface Provider {
  readonly kind: TunnelProviderKind;
  /** 供日志/UI 说明在跑什么命令，不含任何密钥（cloudflared Quick Tunnel 本身无凭证）。 */
  readonly describe: string;
  start(): TunnelProcess;
}

export interface ProviderConfig {
  kind: TunnelProviderKind;
  publicPort: number;
  tunnelCommand: string;
  tunnelUrlPattern: string;
  cloudflaredPath: string;
  connectTimeoutMs: number;
  cwd?: string;
}

export function createProvider(cfg: ProviderConfig): Provider {
  if (cfg.kind === "command") {
    const [command, ...rest] = cfg.tunnelCommand.split(/\s+/).filter(Boolean);
    const parser = makeUrlParser("command", cfg.tunnelUrlPattern, true);
    return {
      kind: "command",
      describe: cfg.tunnelCommand,
      start: () =>
        startTunnelProcess({
          kind: "command",
          command,
          args: rest,
          parseUrl: parser,
          connectTimeoutMs: cfg.connectTimeoutMs,
          cwd: cfg.cwd,
        }),
    };
  }

  const args = [
    "tunnel",
    "--no-autoupdate",
    "--url",
    `http://127.0.0.1:${cfg.publicPort}`,
  ];
  const parser = makeUrlParser("cloudflared", cfg.tunnelUrlPattern, false);
  return {
    kind: "cloudflared",
    // 不在构造时查 PATH：没装客户端也要先把本机服务带起来，等到真正启动隧道时再报错，
    // 否则一个可选的公网组件会阻止整个开发流程（尤其关掉隧道的本地开发）。
    describe: `cloudflared ${args.join(" ")}`,
    start: () => {
      const binary = resolveCloudflaredPath(cfg.cloudflaredPath, cfg.cwd);
      return startTunnelProcess({
        kind: "cloudflared",
        command: binary,
        args,
        parseUrl: parser,
        connectTimeoutMs: cfg.connectTimeoutMs,
        cwd: cfg.cwd,
      });
    },
  };
}

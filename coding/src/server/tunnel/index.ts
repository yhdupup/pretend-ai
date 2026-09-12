import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import { markLinksInvalidated } from "../session/maintenance.js";
import { createProvider, type Provider } from "./provider.js";
import { TunnelManager, type OutageCause } from "./manager.js";

// 阶段3：把 provider + manager 装成进程内单例，供路由和 B 链接拼接使用。
// 单元测试直接 new TunnelManager({provider: 假实现, ...})，不经过这个文件。

/**
 * 按配置决定用哪个隧道（PRD §10.2 P0/P1）。
 * 找不到 cloudflared 客户端时不返回 null：那样 UI 会迺早地显示「未配置」，
 * 而真实情况是「装一下就能用」，所以保留 provider，让 start() 抛 TunnelClientMissingError。
 */
export function buildProvider(): Provider | null {
  if (config.publicBaseUrl) return null; // 已有固定公网基址，不再起本地隧道
  return createProvider({
    kind: config.tunnelCommand ? "command" : "cloudflared",
    publicPort: config.publicPort,
    tunnelCommand: config.tunnelCommand,
    tunnelUrlPattern: config.tunnelUrlPattern,
    cloudflaredPath: config.cloudflaredPath,
    connectTimeoutMs: config.tunnelConnectTimeoutMs,
    cwd: process.cwd(),
  });
}

/**
 * 探活：B 入口的健康检查接口。只回 {ok:true}，不含任何会话信息。
 *
 * 失败时抛带 code 的 ProbeError，让状态机能把「本机 DNS 解析不到」和「隧道没起来」
 * 分开告诉 A —— 这两句话对用户是完全不同的处理方式，但都不能带上域名本身。
 */
export class ProbeError extends Error {
  constructor(readonly code: string) {
    super(`health probe failed: ${code}`);
  }
}

export async function healthCheck(baseUrl: string): Promise<boolean> {
  // 每次一个一次性随机串，要求原样回显（PRD §13.3）：
  // 不回显就不是我们这个 B 入口（CDN 缓存页、别人抢注的域名都过不了这一关）。
  const probe = randomBytes(8).toString("hex");
  const url = `${baseUrl}/api/public/health?probe=${probe}`;
  let res: Response;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(config.tunnelHealthTimeoutMs),
      // 带一次性随机串已经能躲开缓存；再补一个 no-cache 头，兼容比较激进的中间代理
      headers: {
        "user-agent": "ai-window-health",
        "cache-control": "no-cache",
      },
    });
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause?.code ?? "";
    if (/ENOTFOUND|EAI_AGAIN/.test(cause)) throw new ProbeError("DNS");
    if (/ECONNREFUSED/.test(cause)) throw new ProbeError("REFUSED");
    if (/PROXY|ECONNRESET|UND_ERR/.test(cause + " " + (err as Error).name))
      throw new ProbeError("PROXY");
    if ((err as Error).name === "TimeoutError" || /TimeoutAbort/.test(cause))
      throw new ProbeError("TIMEOUT");
    throw new ProbeError(cause || "NETWORK");
  }
  if (!res.ok) throw new ProbeError(`HTTP_${res.status}`);
  const body = (await res.json().catch(() => null)) as {
    ok?: boolean;
    probe?: string | null;
  } | null;
  if (!body || body.ok !== true) throw new ProbeError("BAD_BODY");
  if (body.probe !== probe) throw new ProbeError("STALE_OR_CACHE");
  return true;
}

/**
 * 链接作废的善后：结束所有进行中的会话，并在会话行上留下原因（PRD §4）。
 *
 * 这里刻意不走 closeAllSessions() 的硬删除：B 是真的拿到过有效链接的人，
 * 再打过来时要看到「这个链接已经作废」（410），而不是被当成来路不明的探测者（404）。
 * 聊天正文仍然会被清掉，绑定凭证与轮次也一并删除。
 */
export function endAllSessions(cause: OutageCause): number {
  void cause; // cause 只用于调用点可读性；隧道地址与错误详情一律不写日志
  return markLinksInvalidated(cause);
}

let manager: TunnelManager | null = null;

export function initTunnelManager(): TunnelManager {
  if (manager) return manager;
  manager = new TunnelManager({
    provider: buildProvider(),
    healthCheck,
    endAllSessions,
  });
  return manager;
}

export function getTunnelManager(): TunnelManager {
  return initTunnelManager();
}

/** 仅供测试/优雅退出。 */
export function resetTunnelManager(): void {
  manager?.dispose();
  manager = null;
}

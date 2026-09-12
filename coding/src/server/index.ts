import { proxyProbeMode } from "./net/env-proxy.js";
import "./net/env-proxy.js"; // 必须最先加载：代理设置要在全局 fetch 首次使用前生效（阶段3 探活靠它）
import { startLocalServer } from "./local-server.js";
import { startPublicServer } from "./public-server.js";
import { logger } from "./logger.js";
import { config } from "./config.js";
import { getDb } from "./db/index.js";
import { SessionRepository } from "./session/repository.js";
import { startMaintenance, closeAllSessions } from "./session/maintenance.js";
import { initTunnelManager } from "./tunnel/index.js";
import { setShutdownHook } from "./routes/local/system.js";
import { initCredentialsFromEnv } from "../model/credentials.js";
import type { ServerType } from "@hono/node-server";

// 启动两个独立的服务器：A（本机专用）与 B（局域网/隧道可达）。
// 二者共享同一进程与同一份 SQLite 数据，但监听地址、路由、可见信息完全隔离。

// 启动即清场（PRD §16.6：程序启动时先删除上次异常退出遗留的所有未结束会话，旧链接不得恢复）。
// 内存正文本来就是进程级的、重启即空，这里只需要把 SQLite 残留删干净。
const repo = new SessionRepository(getDb());
const leftover = repo.cleanupAll();
if (leftover.length > 0) {
  // logger 的 meta 是字段白名单（阶段1 隐私设计），计数直接进消息文本。
  logger.info(
    `cleaned ${leftover.length} leftover session(s) from previous run`,
  );
}

// 阶段4：把环境变量里的模型凭证读进内存（只读一次，之后不落盘、不回显，PRD §9.4）。
initCredentialsFromEnv();

// 隧道管理器必须在路由之前初始化：创建会话时要问它拿公网基址来拼 B 链接。
const tunnel = initTunnelManager();
const localServer = startLocalServer();
const publicServer = startPublicServer();
startMaintenance(getDb());

// 探活口径要能在日志里看出来：挂代理的机器上「浏览器能打开、程序说验不通」八成是这里，
// 只记走不走代理，绝不记代理地址（PRD §18.6）。
logger.info("both servers started", {
  probeMode: proxyProbeMode().following
    ? "proxy"
    : `direct:${proxyProbeMode().reason}`,
});

if (config.tunnelAutostart) {
  // 不 await：建隧道是网络操作，本机界面不该被它卡住。失败原因走 /api/local/status。
  void tunnel.start();
} else {
  logger.info("tunnel autostart disabled (TUNNEL_AUTOSTART=false)");
}

// 安全退出：会话不留过夜（PRD §4：程序退出后原链接和原会话失效），隧道子进程不能变成孤儿。
let exiting = false;
async function shutdown(signal: string): Promise<void> {
  if (exiting) return;
  exiting = true;
  const cleaned = closeAllSessions();
  logger.info(`shutting down (${signal}), cleaned ${cleaned} session(s)`);
  tunnel.dispose();
  const servers: ServerType[] = [
    localServer as unknown as ServerType,
    publicServer as unknown as ServerType,
  ];
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          try {
            server.close(() => resolve());
          } catch {
            resolve();
          }
        }),
    ),
  );
  process.exit(0);
}

setShutdownHook(() => shutdown("api"));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

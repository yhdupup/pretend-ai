import { Hono, type Context } from "hono";
import { getDb } from "../../db/index.js";
import { SessionRepository } from "../../session/repository.js";
import {
  closeAllSessions,
  stopMaintenance,
} from "../../session/maintenance.js";
import { logger } from "../../logger.js";
import { getTunnelManager } from "../../tunnel/index.js";
import { config } from "../../config.js";
import { SettingsRepository } from "../../settings/repository.js";
import { credentialsView } from "../../../model/credentials.js";
import {
  getSkillRegistry,
  toPublicSkillState,
} from "../../../assist/skills/loader.js";
import type {
  LocalStatusResponse,
  TunnelActionResponse,
  TunnelManagerLike,
} from "../../../shared/types.js";

// A 本机的系统类接口（PRD §17.1）：
//   GET  /api/local/status            本机和公网状态
//   POST /api/local/tunnel/start      建立公网通道
//   POST /api/local/tunnel/stop       停止（链接失效 + 会话结束）
//   POST /api/local/tunnel/reconnect  手动重连（Quick Tunnel 会换域名 → 旧链接作废）
//   POST /api/local/tunnel/recheck    只重新验一次公网地址能不能通
//   POST /api/local/shutdown          安全退出
//
// 隧道进程是 A 本机才允许操作的组件，所以这些路由只挂在 A 入口（127.0.0.1）；
// B 入口的白名单里没有它们，公网侧碰不到。

/** 退出动作由 index.ts 注入：路由模块自己 process.exit 会让测试没法跑。 */
let shutdownHook: (() => Promise<void> | void) | null = null;
export function setShutdownHook(fn: () => Promise<void> | void): void {
  shutdownHook = fn;
}

/** 仅供测试替换隧道管理器（不传就恢复真实单例）。 */
let managerOverride: TunnelManagerLike | null = null;
export function __setTunnelManagerForTests(
  manager: TunnelManagerLike | null,
): void {
  managerOverride = manager;
}

function manager(): TunnelManagerLike {
  return managerOverride ?? getTunnelManager();
}

// 注意：这里不能用 app.route("/api/local", sub) 的挂载方式。Hono 一旦把某个前缀交给子路由，
// 同前缀下更具体的挂载（/api/local/sessions）就会被它吞掉。所以全部按完整路径登记。
export function registerLocalSystemRoutes(app: Hono): void {
  app.get("/api/local/status", (c) => c.json(statusPayload()));

  function statusPayload(): LocalStatusResponse {
    const db = getDb();
    const repo = new SessionRepository(db);
    const settings = new SettingsRepository(db);
    const registry = getSkillRegistry();
    return {
      serverTime: new Date().toISOString(),
      // 阶段4：只回“能力状态”，不回 Skill 正文、不回密钥（§9.4 §18.6）。
      assist: {
        ...settings.assist(),
        skills: {
          aiStyle: toPublicSkillState(registry.aiStyle),
          analysis: toPublicSkillState(registry.analysis),
        },
        model: { ...credentialsView(), mode: settings.assist().mode },
        limits: {
          maxReplyChars: config.maxReplyChars,
          maxAnalysisChars: config.maxAnalysisChars,
          perMinute: config.processPerMinute,
          minIntervalSeconds: config.processMinIntervalSeconds,
        },
      },
      tunnel: manager().snapshot(),
      sessions: { live: repo.listLive().length },
      localPublicPort: config.publicPort,
      policy: {
        downGraceSeconds: config.tunnelDownGraceSeconds,
        maxReconnectAttempts: config.tunnelMaxReconnectAttempts,
        maxUrlCycles: config.tunnelMaxUrlCycles,
        resetAfterStableSeconds: 60,
      },
    };
  }

  function handle(action: "start" | "stop" | "reconnect" | "recheck") {
    return async (c: Context) => {
      try {
        await manager()[action]();
      } catch (err) {
        // 隧道起不来不能把 A 接口打挂：原因写进状态，页面照常可看。
        // 只记错误类型，不记 message（第三方客户端的报错文本里可能带地址）。
        logger.warn(`tunnel ${action} failed`, {
          errorCode: err instanceof Error ? err.name : "UNKNOWN",
        });
      }
      const response: TunnelActionResponse = {
        ok: true,
        status: statusPayload(),
      };
      return c.json(response);
    };
  }

  app.post("/api/local/tunnel/start", handle("start"));
  app.post("/api/local/tunnel/stop", handle("stop"));
  app.post("/api/local/tunnel/reconnect", handle("reconnect"));
  app.post("/api/local/tunnel/recheck", handle("recheck"));

  // 安全退出：先把会话清干净（不留旧链接），再收隧道子进程，最后交给注入的退出钩子。
  app.post("/api/local/shutdown", (c) => {
    const cleaned = closeAllSessions();
    manager().dispose();
    stopMaintenance();
    logger.info(`shutdown requested, cleaned ${cleaned} session(s)`);
    // 先回响应再退出，否则调用方拿到的是一次连接中断而不是结果
    const t = setTimeout(() => {
      void (shutdownHook ? shutdownHook() : process.exit(0));
    }, 50);
    t.unref?.();
    return c.json({ ok: true, cleaned });
  });
}

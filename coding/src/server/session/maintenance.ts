import type Database from "better-sqlite3";
import { config } from "../config.js";
import { getDb } from "../db/index.js";
import { logger } from "../logger.js";
import { memoryStore } from "./memory-store.js";
import { SessionRepository, type SessionRow } from "./repository.js";
import type {
  LinkInvalidatedReason,
  MaintenanceActions,
  RevealReason,
} from "../../shared/types.js";

// 阶段2 缺口3/4：服务端后台维护器。三件事共用一次扫描：
//   1. 创建满 N 分钟（默认 20，TIME_LIMIT_MINUTES；或第 10 轮已被漏掉）→ 自动揭晓 TIME_LIMIT；
//   2. A 心跳超过 间隔+宽限期 → 关闭会话并清理；
//   3. 创建满 10 小时 → 无条件清理。
// 为什么合并成一个扫描器：三者都是「时间到了服务端自己动」的判断，共用一个 setInterval
// 和一份 listLive() 快照，比三个独立定时器更容易保证顺序稳定（过期优先于揭晓）。
//
// 心跳超时和 A 主动关闭、10 小时过期走的是同一个 repo.cleanup()（PRD §16.6 幂等清理事务）。

// 宽限期只在 A 至少发过一次心跳之后才生效：last_owner_heartbeat_at 为 NULL 表示
// 「A 页面还没打开过」，这种会话交给时间揭晓和 10 小时过期兜底，
// 否则用 curl 建一个会话就会立刻被扫掉，阶段1 的接口自测方式会全线失效。
function heartbeatStale(row: SessionRow, now: Date): boolean {
  const last = row.last_owner_heartbeat_at;
  if (!last) return false;
  const timeoutMs =
    (config.heartbeatIntervalSeconds + config.heartbeatGraceSeconds) * 1000;
  return now.getTime() - Date.parse(last) > timeoutMs;
}

// now 由调用方注入，测试里不 sleep 也能测时间逻辑（开发文档 §四「测试必须用可控时钟」）。
export function runMaintenance(
  repo: SessionRepository,
  now: Date = new Date(),
): MaintenanceActions {
  const actions: MaintenanceActions = { revealed: [], cleaned: [], scanned: 0 };

  for (const row of repo.listLive()) {
    actions.scanned += 1;

    // 顺序 1：10 小时失效。数据已经该删了，再补一次揭晓没有意义（PRD §16.6：过期即清除）。
    if (repo.isExpired(row, now)) {
      if (repo.cleanup(row.id)) memoryStore.clearSession(row.id);
      actions.cleaned.push({ sessionId: row.id, cause: "EXPIRED" });
      continue;
    }

    // 顺序 2：A 失联。会话都没人控制了，留着只会让 B 对着空气提问。
    if (heartbeatStale(row, now)) {
      if (repo.cleanup(row.id)) memoryStore.clearSession(row.id);
      actions.cleaned.push({ sessionId: row.id, cause: "HEARTBEAT_TIMEOUT" });
      continue;
    }

    // 顺序 3：揭晓。与 completeRound 同一条判断链：轮次优先于时间（PRD §5.3）。
    if (row.reveal_state === "HIDDEN") {
      let reason: RevealReason | null = null;
      if (repo.countRounds(row.id) >= config.roundLimit) reason = "ROUND_LIMIT";
      else if (repo.isRevealDeadlinePassed(row, now)) reason = "TIME_LIMIT";
      if (reason) {
        const result = repo.revealIfHidden(row.id, reason);
        if (result?.revealedNow)
          actions.revealed.push({ sessionId: row.id, reason });
      }
    }
  }

  return actions;
}

let timer: NodeJS.Timeout | null = null;

// 只有真实启动的服务进程调用；测试里直接调 runMaintenance(repo, now)，不开定时器。
export function startMaintenance(db: Database.Database): SessionRepository {
  if (timer) return new SessionRepository(db);
  const repo = new SessionRepository(db);
  timer = setInterval(() => {
    try {
      runMaintenance(repo);
    } catch (err) {
      // 维护器不能让进程崩（PRD §10：异常不能导致服务进程崩溃）。只报错误码，
      // 不把 err.message 写进日志——SQLite 的报错文本里可能带 SQL 片段和数据路径。
      logger.error("maintenance sweep failed", {
        errorCode: err instanceof Error ? err.name : "UNKNOWN",
      });
    }
  }, config.maintenanceIntervalMs);
  timer.unref?.();
  return repo;
}

/**
 * 公网链接作废（阶段3）：把进行中的会话就地关掉并留下作废原因。
 * 与 closeAllSessions 的区别是不删 sessions 行 —— B 再打过来要拿到 410 LINK_INVALIDATED，
 * 而不是把他当成来路不明的探测者（他确实拿到过有效链接，PRD §4）。
 */
export function markLinksInvalidated(
  reason: LinkInvalidatedReason,
  now: Date = new Date(),
  repo: SessionRepository = new SessionRepository(getDb()),
): number {
  const ids = repo.closeAndInvalidate(reason, now);
  for (const id of ids) memoryStore.clearSession(id);
  return ids.length;
}

/**
 * 结束所有会话（统一清理事务 + 清内存正文）。
 * 供三处共用：程序启动清场、A 主动退出、公网链接作废（阶段3）。
 */
export function closeAllSessions(
  repo: SessionRepository = new SessionRepository(getDb()),
): number {
  const ids = repo.cleanupAll();
  for (const id of ids) memoryStore.clearSession(id);
  return ids.length;
}

export function stopMaintenance(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

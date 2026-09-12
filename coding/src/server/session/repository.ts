import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import type {
  LinkInvalidatedReason,
  RevealReason,
  RevealState,
  SessionProfile,
  SessionState,
} from "../../shared/types.js";
import {
  assertValidRevealTransition,
  assertValidSessionTransition,
} from "./state-machine.js";

export interface SessionRow {
  id: string;
  state: SessionState;
  reveal_state: RevealState;
  reveal_reason: RevealReason | null;
  revealed_at: string | null;
  created_at: string;
  updated_at: string;
  // 阶段2 新增列（旧库未迁移完成时可能为 undefined，mapper 负责兼容）
  last_owner_heartbeat_at?: string | null;
  reveal_deadline_at?: string | null;
  expires_at?: string | null;
  ai_name?: string | null;
  avatar_id?: string | null;
  opening_message?: string | null;
  reveal_message?: string | null;
  owner_name?: string | null;
  owner_avatar_id?: string | null;
  owner_avatar_data?: string | null;
  /** 假 AI 的上传头像；老库迁移出来是空串（= 用打包进去的默认图）。 */
  ai_avatar_data?: string | null;
  // 阶段3 新增列：公网链接作废时间。作废不另外记轮次、也不改 state，会话该继续还是继续。
  link_invalidated_at?: string | null;
  link_invalidated_reason?: LinkInvalidatedReason | null;
}

export class SessionNotFoundError extends Error {
  constructor(id: string) {
    super(`Session not found: ${id}`);
    this.name = "SessionNotFoundError";
  }
}

export class LinkAlreadyClaimedError extends Error {
  constructor(id: string) {
    super(`Session already claimed: ${id}`);
    this.name = "LinkAlreadyClaimedError";
  }
}

export interface ClaimRow {
  session_id: string;
  credential_hash: string;
  claimed_at: string;
}

export interface CompleteRoundResult {
  row: SessionRow;
  rounds: number;
  // null 表示本轮没达任何揭晓条件；否则为刚写入的 reveal_reason
  revealedReason: RevealReason | null;
}

function addMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

export class SessionRepository {
  constructor(private readonly db: Database.Database) {}

  create(profile?: SessionProfile): SessionRow {
    const now = new Date();
    const nowIso = now.toISOString();
    const row: SessionRow = {
      id: randomUUID(),
      state: "STARTING",
      reveal_state: "HIDDEN",
      reveal_reason: null,
      revealed_at: null,
      created_at: nowIso,
      updated_at: nowIso,
      // PRD §16.2：创建时就定死两个关键时间点，后续所有判断都用服务端时间。
      reveal_deadline_at: new Date(
        now.getTime() + config.timeLimitMinutes * 60_000,
      ).toISOString(),
      expires_at: new Date(
        now.getTime() + config.sessionExpiryHours * 3_600_000,
      ).toISOString(),
      ai_name: profile?.aiName ?? "",
      avatar_id: profile?.avatarId ?? "",
      opening_message: profile?.openingMessage ?? "",
      reveal_message: profile?.revealMessage ?? "",
      owner_name: profile?.ownerName ?? "",
      owner_avatar_id: profile?.ownerAvatarId ?? "",
      owner_avatar_data: profile?.ownerAvatarData ?? "",
      ai_avatar_data: profile?.avatarData ?? "",
    };
    this.db
      .prepare(
        `INSERT INTO sessions (id, state, reveal_state, reveal_reason, revealed_at, created_at, updated_at,
          reveal_deadline_at, expires_at, ai_name, avatar_id, opening_message, reveal_message, owner_name, owner_avatar_id, owner_avatar_data, ai_avatar_data)
         VALUES (@id, @state, @reveal_state, @reveal_reason, @revealed_at, @created_at, @updated_at,
          @reveal_deadline_at, @expires_at, @ai_name, @avatar_id, @opening_message, @reveal_message, @owner_name, @owner_avatar_id, @owner_avatar_data, @ai_avatar_data)`,
      )
      .run(row);

    // 创建后立即进入 WAITING（等待 B 首次进入），阶段1不做异步等待逻辑。
    return this.transitionState(row.id, "WAITING");
  }

  findById(id: string): SessionRow | undefined {
    return this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as
      SessionRow | undefined;
  }

  requireById(id: string): SessionRow {
    const row = this.findById(id);
    if (!row) throw new SessionNotFoundError(id);
    return row;
  }

  transitionState(id: string, to: SessionState): SessionRow {
    const current = this.requireById(id);
    assertValidSessionTransition(current.state, to);
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE sessions SET state = ?, updated_at = ? WHERE id = ?`)
      .run(to, now, id);
    return this.requireById(id);
  }

  reveal(id: string, reason: RevealReason): SessionRow {
    const current = this.requireById(id);
    assertValidRevealTransition(current.reveal_state, "REVEALED");
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE sessions SET reveal_state = 'REVEALED', reveal_reason = ?, revealed_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(reason, now, now, id);
    return this.requireById(id);
  }

  recordRound(id: string, roundIndex: number): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO rounds (session_id, round_index, created_at) VALUES (?, ?, ?)`,
      )
      .run(id, roundIndex, now);
  }

  countRounds(id: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as count FROM rounds WHERE session_id = ?`)
      .get(id) as { count: number };
    return row.count;
  }

  /**
   * 单B绑定。依赖 claims.session_id 的唯一约束做并发互斥：
   * 并发两次 claim 只有一个 INSERT 成功，另一个抛 SqliteError（UNIQUE 冲突），
   * 这里捕获后转换为语义化的 LinkAlreadyClaimedError，供路由层映射为 409。
   */
  claim(sessionId: string, credentialHash: string): ClaimRow {
    const now = new Date().toISOString();
    try {
      this.db
        .prepare(
          `INSERT INTO claims (session_id, credential_hash, claimed_at) VALUES (?, ?, ?)`,
        )
        .run(sessionId, credentialHash, now);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("UNIQUE constraint failed")) {
        throw new LinkAlreadyClaimedError(sessionId);
      }
      throw err;
    }
    return this.findClaim(sessionId) as ClaimRow;
  }

  findClaim(sessionId: string): ClaimRow | undefined {
    return this.db
      .prepare(`SELECT * FROM claims WHERE session_id = ?`)
      .get(sessionId) as ClaimRow | undefined;
  }

  // ---------- 阶段2 缺口2/3：轮次与揭晓 ----------

  // A 心跳（PRD §10 每 5 秒一次，本阶段用 REST 代替 WebSocket 应用层心跳）。
  touchHeartbeat(id: string): SessionRow | undefined {
    if (!this.findById(id)) return undefined;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE sessions SET last_owner_heartbeat_at = @now, updated_at = @now WHERE id = @id`,
      )
      .run({ id, now });
    return this.findById(id);
  }

  // 条件式揭晓：只有当前仍为 HIDDEN 才写入，因此重复揭晓是 no-op，
  // 不会抛 SESSION_REVEAL_TRANSITION_INVALID 到路由层（开发文档 §缺口3）。
  // 回衽行数就是并发守卫，不需要先 SELECT 再 UPDATE（两步之间可能被别人改掉）。
  revealIfHidden(
    id: string,
    reason: RevealReason,
  ): { row: SessionRow; revealedNow: boolean } | undefined {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `UPDATE sessions
            SET reveal_state = 'REVEALED', reveal_reason = @reason, revealed_at = @now, updated_at = @now
          WHERE id = @id AND reveal_state = 'HIDDEN'`,
      )
      .run({ id, reason, now });
    const row = this.findById(id);
    if (!row) return undefined;
    return { row, revealedNow: info.changes > 0 };
  }

  // 完成一轮：写轮次 + 判揭晓（+ 必要时推 ACTIVE），全部在同一个 SQLite 事务里，
  // 对应 PRD §16.6“完成一轮时，消息状态、轮次和揭晓判断原子更新”。
  // 调用顺序：调用方先在内存里取到待回复的 B 问题再调本方法；内存消息的追写在路由里完成。
  completeRound(id: string): CompleteRoundResult | undefined {
    let result: CompleteRoundResult | undefined;
    const tx = this.db.transaction(() => {
      const before = this.findById(id);
      if (!before) return;
      const roundIndex = this.countRounds(id) + 1;
      this.recordRound(id, roundIndex);
      const rounds = this.countRounds(id);

      let revealedReason: RevealReason | null = null;
      const hidden = before.reveal_state === "HIDDEN";
      if (hidden && rounds >= config.roundLimit) {
        // PRD §5.3：多个条件同时满足时，第 10 轮发送事务优先记 ROUND_LIMIT。
        revealedReason = "ROUND_LIMIT";
      } else if (hidden && this.isRevealDeadlinePassed(before)) {
        revealedReason = "TIME_LIMIT";
      }
      if (revealedReason) this.revealIfHidden(id, revealedReason);

      result = { row: this.requireById(id), rounds, revealedReason };
    });
    // .immediate()：BEGIN IMMEDIATE 先拿写锁。默认的 deferred 事务会先读后写，
    // WAL 下只要期间有别的连接提交过写入，升级写锁就会报 SQLITE_BUSY_SNAPSHOT，
    // 而这个错误 busy_timeout 不会重试（本机能同时开多个测试进程/浏览器标签页）。
    tx.immediate();
    return result;
  }

  isRevealDeadlinePassed(row: SessionRow, now: Date = new Date()): boolean {
    const deadline =
      row.reveal_deadline_at ??
      addMs(row.created_at, config.timeLimitMinutes * 60_000);
    return now.getTime() >= Date.parse(deadline);
  }

  isExpired(row: SessionRow, now: Date = new Date()): boolean {
    const expiresAt =
      row.expires_at ??
      addMs(row.created_at, config.sessionExpiryHours * 3_600_000);
    return now.getTime() >= Date.parse(expiresAt);
  }

  // 后台维护器需要扫描的会话：未进入终态的全部。终态行本身也应该已被清理，
  // 这里多包一层 state 过滤是为了防御旧版本遗留数据。
  listLive(): SessionRow[] {
    return this.db
      .prepare(
        `SELECT * FROM sessions WHERE state NOT IN ('CLOSED', 'EXPIRED') ORDER BY created_at ASC`,
      )
      .all() as SessionRow[];
  }

  // ---------- 阶段2 缺口4：统一清理事务 ----------

  // PRD §16.6：正常关闭、心跳超时和 10 小时过期共用同一个幂等清理事务，
  // 删除 sessions 行及其令牌、B 凭证、轮次和揭晓元数据（先删子表再删主表，
  // 因为开了 foreign_keys = ON）。不存在时返回 false，重复调用不报错。
  /**
   * 公网链接作废（阶段3）：把仍在进行的会话就地关掉，并在行上留下作废原因。
   *
   * 和 cleanup() 的区别只有一处：**不删 sessions 这一行**。
   * 因为 B 是真的拿到过有效链接的人，再打过来时应该告诉他「这个链接已经作废」（410），
   * 而不是把他当成一个来路不明的探测者（404）——两种情况的处理义务不一样（PRD §4）。
   * 聊天正文只在内存里，调用方会顺手清掉；绑定凭证与轮次属于「这轮结束了」的数据，这里删。
   */
  closeAndInvalidate(reason: LinkInvalidatedReason, at: Date): string[] {
    const stamp = at.toISOString();
    const affected = (
      this.db
        .prepare(
          `SELECT id FROM sessions WHERE state NOT IN ('CLOSED', 'EXPIRED') AND link_invalidated_at IS NULL`,
        )
        .all() as Array<{ id: string }>
    ).map((r) => r.id);
    if (affected.length === 0) return [];
    const close = this.db.prepare(
      `UPDATE sessions
         SET state = 'CLOSED', link_invalidated_at = @at, link_invalidated_reason = @reason, updated_at = @at
       WHERE id = @id`,
    );
    const delRounds = this.db.prepare(
      `DELETE FROM rounds WHERE session_id = @id`,
    );
    const delClaims = this.db.prepare(
      `DELETE FROM claims WHERE session_id = @id`,
    );
    const delKeys = this.db.prepare(
      `DELETE FROM idempotency_keys WHERE session_id = @id`,
    );
    const tx = this.db.transaction(() => {
      for (const id of affected) {
        close.run({ id, at: stamp, reason });
        delRounds.run({ id });
        delClaims.run({ id });
        delKeys.run({ id });
      }
    });
    tx.immediate();
    return affected;
  }

  /**
   * 过期回收：创建满 10 小时的行无条件删掉（PRD §4）。
   * 已作废的链接行也要能被收掉，否则它们会一直躺在库里。
   */
  sweepExpired(now: Date = new Date()): string[] {
    const cutoff = new Date(
      now.getTime() - config.sessionExpiryHours * 3600_000,
    ).toISOString();
    const ids = (
      this.db
        .prepare(`SELECT id FROM sessions WHERE created_at <= ?`)
        .all(cutoff) as Array<{ id: string }>
    ).map((r) => r.id);
    for (const id of ids) this.cleanup(id);
    return ids;
  }

  cleanup(id: string): boolean {
    let deleted = false;
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM rounds WHERE session_id = @id`).run({ id });
      this.db.prepare(`DELETE FROM claims WHERE session_id = @id`).run({ id });
      this.db
        .prepare(`DELETE FROM idempotency_keys WHERE session_id = @id`)
        .run({ id });
      const info = this.db
        .prepare(`DELETE FROM sessions WHERE id = @id`)
        .run({ id });
      deleted = info.changes > 0;
    });
    tx.immediate();
    return deleted;
  }

  // 程序启动时清掉上次异常退出遗留的所有会话（PRD §16.6：旧链接不得恢复）。
  cleanupAll(): string[] {
    const ids = (
      this.db.prepare(`SELECT id FROM sessions`).all() as Array<{ id: string }>
    ).map((r) => r.id);
    for (const id of ids) this.cleanup(id);
    return ids;
  }
}

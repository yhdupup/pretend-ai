import type Database from "better-sqlite3";
import { createHash } from "node:crypto";

// Idempotency-Key 逻辑（开发文档 §七）：
// 同 key + 相同内容 -> 返回相同缓存结果；同 key + 不同内容 -> 409。

export class IdempotencyConflictError extends Error {
  constructor(key: string) {
    super(`Idempotency key conflict: ${key}`);
    this.name = "IdempotencyConflictError";
  }
}

interface IdempotencyRow {
  key: string;
  session_id: string;
  content_hash: string;
  response_json: string;
  created_at: string;
}

export function hashContent(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

export class IdempotencyStore {
  constructor(private readonly db: Database.Database) {}

  private find(key: string, sessionId: string): IdempotencyRow | undefined {
    // 按 key + session_id 联合查找：同一 key 字符串在不同会话下应视为互相独立的幂等域，
    // 避免跨会话的字符串碰撞导致误命中缓存（尤其是测试/客户端固定 key 场景）。
    return this.db
      .prepare(
        `SELECT * FROM idempotency_keys WHERE key = ? AND session_id = ?`,
      )
      .get(key, sessionId) as IdempotencyRow | undefined;
  }

  /**
   * 若 key 已存在（同一 session 内）：内容一致则返回缓存的 response；内容不一致则抛出 IdempotencyConflictError。
   * 若 key 不存在：调用 compute 生成新结果并落库，返回新结果。
   */
  resolve<T>(
    key: string,
    sessionId: string,
    body: string,
    compute: () => T,
  ): T {
    const contentHash = hashContent(body);
    const existing = this.find(key, sessionId);
    if (existing) {
      if (existing.content_hash !== contentHash) {
        throw new IdempotencyConflictError(key);
      }
      return JSON.parse(existing.response_json) as T;
    }

    const result = compute();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO idempotency_keys (key, session_id, content_hash, response_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(key, sessionId, contentHash, JSON.stringify(result), now);
    return result;
  }
}

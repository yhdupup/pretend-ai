import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createInMemoryDb } from "../src/server/db/index.js";
import {
  LinkAlreadyClaimedError,
  SessionNotFoundError,
  SessionRepository,
} from "../src/server/session/repository.js";
import { InvalidTransitionError } from "../src/server/session/state-machine.js";

describe("SessionRepository", () => {
  let db: Database.Database;
  let repo: SessionRepository;

  beforeEach(() => {
    db = createInMemoryDb();
    repo = new SessionRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it("creates a session that is already in WAITING state", () => {
    const row = repo.create();
    expect(row.state).toBe("WAITING");
    expect(row.reveal_state).toBe("HIDDEN");
    expect(row.reveal_reason).toBeNull();
    expect(row.revealed_at).toBeNull();
  });

  it("finds a session by id, and returns undefined for unknown ids", () => {
    const created = repo.create();
    expect(repo.findById(created.id)?.id).toBe(created.id);
    expect(repo.findById("does-not-exist")).toBeUndefined();
  });

  it("requireById throws SessionNotFoundError for unknown ids", () => {
    expect(() => repo.requireById("does-not-exist")).toThrow(
      SessionNotFoundError,
    );
  });

  it("transitions state following the state machine rules", () => {
    const created = repo.create();
    const active = repo.transitionState(created.id, "ACTIVE");
    expect(active.state).toBe("ACTIVE");
  });

  it("rejects illegal state transitions via the underlying state machine", () => {
    const created = repo.create();
    // WAITING -> CLOSED 不在允许列表中
    expect(() => repo.transitionState(created.id, "CLOSED")).toThrow(
      InvalidTransitionError,
    );
  });

  it("reveal sets reveal_state, reveal_reason and revealed_at", () => {
    const created = repo.create();
    const revealed = repo.reveal(created.id, "OWNER_ACTION");
    expect(revealed.reveal_state).toBe("REVEALED");
    expect(revealed.reveal_reason).toBe("OWNER_ACTION");
    expect(revealed.revealed_at).not.toBeNull();
  });

  it("rejects a second reveal with InvalidTransitionError (idempotency guard for 409)", () => {
    const created = repo.create();
    repo.reveal(created.id, "OWNER_ACTION");
    expect(() => repo.reveal(created.id, "ROUND_LIMIT")).toThrow(
      InvalidTransitionError,
    );
  });

  it("recordRound + countRounds track distinct round indices, ignoring duplicates", () => {
    const created = repo.create();
    repo.recordRound(created.id, 0);
    repo.recordRound(created.id, 1);
    repo.recordRound(created.id, 1); // 重复 round_index，应被 INSERT OR IGNORE 忽略
    expect(repo.countRounds(created.id)).toBe(2);
  });

  // 阶段2 缺口1：单B绑定。这里只测数据库层的互斥语义（claims.session_id UNIQUE 约束），
  // HTTP层的并发互斥（一个200+其余409）在 test/claim.test.ts 里通过真实路由栈验证。
  it("findClaim returns undefined before any claim exists", () => {
    const created = repo.create();
    expect(repo.findClaim(created.id)).toBeUndefined();
  });

  it("claim stores the credential hash and findClaim returns it back", () => {
    const created = repo.create();
    const claim = repo.claim(created.id, "hash-1");
    expect(claim.session_id).toBe(created.id);
    expect(claim.credential_hash).toBe("hash-1");
    expect(repo.findClaim(created.id)?.credential_hash).toBe("hash-1");
  });

  it("a second claim on the same session throws LinkAlreadyClaimedError (UNIQUE 约束互斥)", () => {
    const created = repo.create();
    repo.claim(created.id, "hash-1");
    expect(() => repo.claim(created.id, "hash-2")).toThrow(
      LinkAlreadyClaimedError,
    );
    // 第二次绑定失败后，claims 表里仍应是第一次的凭证哈希，未被覆盖。
    expect(repo.findClaim(created.id)?.credential_hash).toBe("hash-1");
  });
});

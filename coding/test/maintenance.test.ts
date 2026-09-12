import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createInMemoryDb } from "../src/server/db/index.js";
import { SessionRepository } from "../src/server/session/repository.js";
import { memoryStore } from "../src/server/session/memory-store.js";
import { runMaintenance } from "../src/server/session/maintenance.js";
import { config } from "../src/server/config.js";
import type { SessionProfile } from "../src/shared/types.js";

// 阶段2 缺口2/3/4：轮次、自动揭晓、心跳超时与过期清理。
//
// 时间常量保持生产值（10 轮 / 20 分钟 / 10 小时），但绝不 sleep：
// 时间由两个手段控制——直接把 sessions 行上的时间列改到过去，以及给 runMaintenance 注入 now。
// （开发文档 §四：测试必须用可控时钟。）

const PROFILE: SessionProfile = {
  aiName: "小雷 AI",
  avatarId: "robot-02",
  openingMessage: "你好",
  revealMessage: "其实是活人",
  ownerName: "小李",
  ownerAvatarId: "robot-03",
};

function minutesFromNow(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

describe("SessionRepository 轮次与揭晓", () => {
  let db: Database.Database;
  let repo: SessionRepository;

  beforeEach(() => {
    db = createInMemoryDb();
    repo = new SessionRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it("创建会话时就写死揭晓与过期时间点，并快照本机身份", () => {
    const row = repo.create(PROFILE);
    expect(Date.parse(row.reveal_deadline_at!)).toBeGreaterThan(
      Date.parse(row.created_at),
    );
    expect(row.reveal_deadline_at).toBe(
      minutesFromNow(row.created_at, config.timeLimitMinutes),
    );
    expect(Date.parse(row.expires_at!)).toBe(
      Date.parse(row.created_at) + config.sessionExpiryHours * 3_600_000,
    );
    expect(row.owner_name).toBe("小李");
    expect(row.avatar_id).toBe("robot-02");
    expect(row.owner_avatar_id).toBe("robot-03");
  });

  it("满 10 轮的那一次 completeRound 触发 ROUND_LIMIT 揭晓，前 9 次不揭晓", () => {
    const created = repo.create(PROFILE);
    for (let i = 1; i <= config.roundLimit - 1; i++) {
      const done = repo.completeRound(created.id);
      expect(done?.rounds).toBe(i);
      expect(done?.revealedReason).toBeNull();
      expect(repo.findById(created.id)?.reveal_state).toBe("HIDDEN");
    }
    const last = repo.completeRound(created.id);
    expect(last?.rounds).toBe(config.roundLimit);
    expect(last?.revealedReason).toBe("ROUND_LIMIT");
    const row = repo.findById(created.id)!;
    expect(row.reveal_state).toBe("REVEALED");
    expect(row.revealed_at).not.toBeNull();
    // 揭晓不改变会话状态：PRD §12 里 reveal_state 与 state 是两个独立字段
    expect(row.state).toBe("WAITING");
  });

  it("创建满时间上限后，任何一次 completeRound 都记 TIME_LIMIT", () => {
    const created = repo.create(PROFILE);
    db.prepare(`UPDATE sessions SET reveal_deadline_at = ? WHERE id = ?`).run(
      "2000-01-01T00:00:00.000Z",
      created.id,
    );
    const done = repo.completeRound(created.id);
    expect(done?.revealedReason).toBe("TIME_LIMIT");
  });

  it("轮次与时间同时满足时，记 ROUND_LIMIT（PRD §5.3 优先级）", () => {
    const created = repo.create(PROFILE);
    db.prepare(`UPDATE sessions SET reveal_deadline_at = ? WHERE id = ?`).run(
      "2000-01-01T00:00:00.000Z",
      created.id,
    );
    for (let i = 1; i < config.roundLimit; i++) repo.recordRound(created.id, i);
    const done = repo.completeRound(created.id);
    expect(done?.revealedReason).toBe("ROUND_LIMIT");
  });

  it("revealIfHidden 重复调用是 no-op，不会覆盖首次揭晓时间", () => {
    const created = repo.create(PROFILE);
    const first = repo.revealIfHidden(created.id, "TIME_LIMIT");
    expect(first?.revealedNow).toBe(true);
    const firstAt = first?.row.revealed_at;

    const second = repo.revealIfHidden(created.id, "ROUND_LIMIT");
    expect(second?.revealedNow).toBe(false);
    expect(second?.row.reveal_reason).toBe("TIME_LIMIT");
    expect(second?.row.revealed_at).toBe(firstAt);
  });

  it("touchHeartbeat 记录 A 最近心跳时间", () => {
    const created = repo.create(PROFILE);
    expect(
      repo.findById(created.id)?.last_owner_heartbeat_at ?? null,
    ).toBeNull();
    const row = repo.touchHeartbeat(created.id);
    expect(row?.last_owner_heartbeat_at).toBeTruthy();
    expect(repo.touchHeartbeat("nope")).toBeUndefined();
  });
});

describe("runMaintenance（缺口3/4 后台扫描）", () => {
  let db: Database.Database;
  let repo: SessionRepository;

  beforeEach(() => {
    db = createInMemoryDb();
    repo = new SessionRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it("到点、没有新消息时也自动揭晓 TIME_LIMIT", () => {
    const created = repo.create(PROFILE);
    const future = new Date(
      Date.parse(created.created_at) + (config.timeLimitMinutes + 1) * 60_000,
    );
    const actions = runMaintenance(repo, future);
    expect(actions.revealed).toEqual([
      { sessionId: created.id, reason: "TIME_LIMIT" },
    ]);
    expect(repo.findById(created.id)?.reveal_state).toBe("REVEALED");
    // 揭晓之后会话还在，B 仍可继续聊天
    expect(actions.cleaned).toHaveLength(0);

    // 再扫一轮不会重复揭晓（只揭晓一次）
    expect(runMaintenance(repo, future).revealed).toHaveLength(0);
  });

  it("A 心跳超时 -> 关闭并清理，会话行与轮次、凭证一起删除", () => {
    const created = repo.create(PROFILE);
    repo.completeRound(created.id);
    repo.claim(created.id, "hash-1");
    repo.touchHeartbeat(created.id);
    const stale = new Date(
      Date.parse(created.created_at) +
        (config.heartbeatIntervalSeconds + config.heartbeatGraceSeconds + 5) *
          1000,
    );
    db.prepare(
      `UPDATE sessions SET last_owner_heartbeat_at = ? WHERE id = ?`,
    ).run(created.created_at, created.id);

    const actions = runMaintenance(repo, stale);
    expect(actions.cleaned).toEqual([
      { sessionId: created.id, cause: "HEARTBEAT_TIMEOUT" },
    ]);
    expect(repo.findById(created.id)).toBeUndefined();
    expect(
      db
        .prepare(`SELECT COUNT(*) AS c FROM rounds WHERE session_id = ?`)
        .get(created.id),
    ).toEqual({ c: 0 });
    expect(repo.findClaim(created.id)).toBeUndefined();
  });

  it("从没发过心跳的会话不被心跳规则误杀（交给揭晓/过期兜底）", () => {
    const created = repo.create(PROFILE);
    // 1 小时：远超心跳超时窗口，但远未到 10 小时，且 A 从未发过心跳。
    const later = new Date(Date.parse(created.created_at) + 60 * 60_000);
    const actions = runMaintenance(repo, later);
    expect(actions.cleaned).toHaveLength(0);
    expect(actions.revealed).toEqual([
      { sessionId: created.id, reason: "TIME_LIMIT" },
    ]);
    expect(repo.findById(created.id)).toBeDefined();
  });

  it("创建满 10 小时 -> 无条件清理，且过期判断优先于揭晓", () => {
    const created = repo.create(PROFILE);
    const farFuture = new Date(
      Date.parse(created.created_at) +
        (config.sessionExpiryHours + 1) * 3_600_000,
    );
    const actions = runMaintenance(repo, farFuture);
    expect(actions.cleaned).toEqual([
      { sessionId: created.id, cause: "EXPIRED" },
    ]);
    expect(repo.findById(created.id)).toBeUndefined();
    expect(actions.revealed).toHaveLength(0);
  });

  it("内存正文随会话一起清掉；cleanup 幂等", () => {
    const created = repo.create(PROFILE);
    memoryStore.appendMessage(created.id, "A", "正文");
    memoryStore.createPending(created.id, "问题");
    expect(memoryStore.getMessages(created.id)).toHaveLength(1);

    expect(repo.cleanup(created.id)).toBe(true);
    memoryStore.clearSession(created.id);
    expect(memoryStore.getMessages(created.id)).toHaveLength(0);
    expect(memoryStore.listPending(created.id)).toHaveLength(0);

    // 幂等：再删一次不报错，只返回 false（PRD §16.6 同一个清理事务三种触发共用）
    expect(repo.cleanup(created.id)).toBe(false);
  });

  it("cleanupAll 删除所有遗留会话（启动清场，旧链接不得恢复）", () => {
    const a = repo.create(PROFILE);
    const b = repo.create(PROFILE);
    memoryStore.appendMessage(a.id, "A", "上次进程遗留的正文");
    expect(repo.listLive()).toHaveLength(2);

    const ids = repo.cleanupAll();
    expect(ids.sort()).toEqual([a.id, b.id].sort());
    expect(repo.listLive()).toHaveLength(0);
    expect(repo.findById(a.id)).toBeUndefined();
    memoryStore.clearSession(a.id);
    memoryStore.clearSession(b.id);
  });

  it("只扫未进入终态的会话", () => {
    const live = repo.create(PROFILE);
    db.prepare(`UPDATE sessions SET state = 'CLOSED' WHERE id = ?`).run(
      live.id,
    );
    expect(repo.listLive()).toHaveLength(0);
    expect(
      runMaintenance(
        repo,
        new Date(Date.parse(live.created_at) + 999 * 3_600_000),
      ).scanned,
    ).toBe(0);
  });
});

// 阶段4 §24.4：限速的两个阈值可以分别关掉，0 必须表示「不限」而不是「全拦」。
// 真模型批量自测（scripts/smoke-model.mjs）就是靠传 0 关掉限速跑的，
// 语义写反会让整批用例第 7 次调用起全红，而且红得看不出原因。
describe("处理草稿限速", () => {
  it("最小间隔与每分钟次数分别生效", () => {
    const id = "rate-interval";
    const t0 = 1_700_000_000_000;
    expect(memoryStore.allowProcess(id, t0, 3000, 3)).toBe(true);
    expect(memoryStore.allowProcess(id, t0 + 1000, 3000, 3)).toBe(false);
    expect(memoryStore.allowProcess(id, t0 + 4000, 3000, 3)).toBe(true);
    expect(memoryStore.allowProcess(id, t0 + 8000, 3000, 3)).toBe(true);
    // 第 4 次落在同一 60 秒窗口内，次数用完
    expect(memoryStore.allowProcess(id, t0 + 12000, 3000, 3)).toBe(false);
    // 一分钟前的记录滑出窗口后重新可用
    expect(memoryStore.allowProcess(id, t0 + 61000, 3000, 3)).toBe(true);
  });

  it("阈值 0（或负数）= 该项不限", () => {
    const id = "rate-off";
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 30; i++) {
      expect(memoryStore.allowProcess(id, t0, 0, 0)).toBe(true);
    }
    expect(memoryStore.allowProcess(id, t0 + 1, -5, -5)).toBe(true);
  });

  it("会话清理时限速记录一起消失", () => {
    const id = "rate-cleared";
    const t0 = 1_700_000_000_000;
    expect(memoryStore.allowProcess(id, t0, 3000, 6)).toBe(true);
    memoryStore.clearSession(id);
    expect(memoryStore.allowProcess(id, t0 + 100, 3000, 6)).toBe(true);
  });
});

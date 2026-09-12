import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { config } from "../config.js";

let dbInstance: Database.Database | null = null;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    reveal_state TEXT NOT NULL,
    reveal_reason TEXT,
    revealed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS rounds (
    session_id TEXT NOT NULL,
    round_index INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (session_id, round_index),
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS idempotency_keys (
    key TEXT NOT NULL,
    session_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (key, session_id)
  );
  `,
  // 阶段2 缺口1：单B绑定。session_id 唯一约束用于并发互斥（第二次 claim 因唯一约束冲突而失败），
  // 不依赖应用层锁（技术适配声明§16.6要求交给数据库保证互斥）。
  `
  CREATE TABLE IF NOT EXISTS claims (
    session_id TEXT NOT NULL UNIQUE,
    credential_hash TEXT NOT NULL,
    claimed_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  );
  `,
  // 阶段2 缺口5：本机设置（PRD §16.4）。只存与聊天内容无关的本机身份与默认揭晓留言。
  // AI 名称、头像、开场白属于「创建窗口」每次填的内容，不落在设置表里（PRD §7.1 §16.4）。
  // PRD 还列了 ai_style_enabled / analysis_enabled / 两个 Skill 路径，属于阶段4，
  // 本次不预先建空列，避免“表里有字段但没人读写”。
  `
  CREATE TABLE IF NOT EXISTS local_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    owner_name TEXT NOT NULL DEFAULT '',
    owner_avatar_id TEXT NOT NULL DEFAULT 'robot-01',
    owner_avatar_data TEXT NOT NULL DEFAULT '',
    default_reveal_message TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );
  `,
];

// 阶段2/3 需要给已有的 sessions 表加列（阶段1 已建表，CREATE TABLE IF NOT EXISTS 不会补列）。
// 不用 try/catch 吞 duplicate column 错，而是先查 table_info，保证反复启动幂等。
const COLUMN_MIGRATIONS: Array<{ table: string; column: string; ddl: string }> =
  [
    // 缺口3/4：揭晓与过期计算用的时间列；缺口5：创建会话时快照下来的身份与文案（PRD §16.2）。
    {
      table: "sessions",
      column: "last_owner_heartbeat_at",
      ddl: "ALTER TABLE sessions ADD COLUMN last_owner_heartbeat_at TEXT",
    },
    {
      table: "sessions",
      column: "reveal_deadline_at",
      ddl: "ALTER TABLE sessions ADD COLUMN reveal_deadline_at TEXT",
    },
    {
      table: "sessions",
      column: "expires_at",
      ddl: "ALTER TABLE sessions ADD COLUMN expires_at TEXT",
    },
    {
      table: "sessions",
      column: "ai_name",
      ddl: "ALTER TABLE sessions ADD COLUMN ai_name TEXT NOT NULL DEFAULT ''",
    },
    {
      table: "sessions",
      column: "avatar_id",
      ddl: "ALTER TABLE sessions ADD COLUMN avatar_id TEXT NOT NULL DEFAULT ''",
    },
    {
      table: "sessions",
      column: "opening_message",
      ddl: "ALTER TABLE sessions ADD COLUMN opening_message TEXT NOT NULL DEFAULT ''",
    },
    {
      table: "sessions",
      column: "reveal_message",
      ddl: "ALTER TABLE sessions ADD COLUMN reveal_message TEXT NOT NULL DEFAULT ''",
    },
    {
      table: "sessions",
      column: "owner_name",
      ddl: "ALTER TABLE sessions ADD COLUMN owner_name TEXT NOT NULL DEFAULT ''",
    },
    // 揭晓弹窗里显示的是 A 自己的头像（PRD §7.5），与虚构 AI 的 avatar_id 是两个东西。
    {
      table: "sessions",
      column: "owner_avatar_id",
      ddl: "ALTER TABLE sessions ADD COLUMN owner_avatar_id TEXT NOT NULL DEFAULT ''",
    },
    // 阶段5：A 上传自己的**身份**头像（作者 2026-09-12：内置四个不够用）。
    // 两边各一列，跟 owner_name / owner_avatar_id 一样是「创建时快照」：
    // A 之后换头像不能把已经发出去的链接上的身份改掉（PRD §16.2）。
    // 存的是浏览器压到 256×256 后的 data URL，不开文件目录，也不新增公开路由。
    {
      table: "local_settings",
      column: "owner_avatar_data",
      ddl: "ALTER TABLE local_settings ADD COLUMN owner_avatar_data TEXT NOT NULL DEFAULT ''",
    },
    {
      table: "sessions",
      column: "owner_avatar_data",
      ddl: "ALTER TABLE sessions ADD COLUMN owner_avatar_data TEXT NOT NULL DEFAULT ''",
    },
    {
      table: "sessions",
      // 假 AI 的上传头像（2026-09-13）。默认不传时这一列是空串，B 端退回打包进去的默认图。
      column: "ai_avatar_data",
      ddl: "ALTER TABLE sessions ADD COLUMN ai_avatar_data TEXT NOT NULL DEFAULT ''",
    },
    // 阶段3：公网链接作废标记。放最后追加，且允许为 NULL —— 老库里已有的会话本来就还没作废过。
    {
      table: "sessions",
      column: "link_invalidated_at",
      ddl: "ALTER TABLE sessions ADD COLUMN link_invalidated_at TEXT",
    },
    {
      table: "sessions",
      column: "link_invalidated_reason",
      ddl: "ALTER TABLE sessions ADD COLUMN link_invalidated_reason TEXT",
    },
    // 阶段4：生成模式与两个开关（PRD §16.5）。模式/开关是「上次选择」，可以落库；模型密钥不行（§9.4）。
    {
      table: "local_settings",
      column: "model_mode",
      ddl: "ALTER TABLE local_settings ADD COLUMN model_mode TEXT NOT NULL DEFAULT 'rules'",
    },
    {
      table: "local_settings",
      column: "ai_style_enabled",
      ddl: "ALTER TABLE local_settings ADD COLUMN ai_style_enabled INTEGER NOT NULL DEFAULT 1",
    },
    {
      table: "local_settings",
      column: "analysis_enabled",
      ddl: "ALTER TABLE local_settings ADD COLUMN analysis_enabled INTEGER NOT NULL DEFAULT 1",
    },
    {
      table: "local_settings",
      column: "style_level",
      ddl: "ALTER TABLE local_settings ADD COLUMN style_level TEXT NOT NULL DEFAULT '明显'",
    },
  ];

function hasColumn(
  db: Database.Database,
  table: string,
  column: string,
): boolean {
  const rows = db.prepare("PRAGMA table_info(" + table + ")").all() as Array<{
    name: string;
  }>;
  return rows.some((r) => r.name === column);
}

function runMigrations(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // 多个测试文件（claim / integration）会在不同 worker 进程里 open 同一个 dev.sqlite，
  // 阶段2 的 completeRound 是显式写事务，抢锁概率比阶段1 的单条 UPDATE 高很多；
  // 没有 busy_timeout 时直接收到 SQLITE_BUSY 并向上抛成 500。WAL 下等锁是安全的。
  db.pragma("busy_timeout = 5000");
  const tx = db.transaction(() => {
    for (const statement of MIGRATIONS) {
      db.exec(statement);
    }
    for (const col of COLUMN_MIGRATIONS) {
      if (!hasColumn(db, col.table, col.column)) db.exec(col.ddl);
    }
  });
  // 同上：多个进程同时首次建库时，deferred 事务会撞出 SQLITE_BUSY_SNAPSHOT。
  tx.immediate();
}

export function getDb(): Database.Database {
  if (dbInstance) return dbInstance;

  const resolvedPath = path.resolve(process.cwd(), config.localDataPath);
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  dbInstance = new Database(resolvedPath);
  runMigrations(dbInstance);
  return dbInstance;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

/** 测试专用：创建独立的内存数据库实例，不影响全局单例。 */
export function createInMemoryDb(): Database.Database {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

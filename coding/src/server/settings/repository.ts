import { DEFAULT_AVATAR_ID, isAvatarId, sanitizeAvatarData } from "../../shared/avatars.js";
import { config } from "../config.js";
import type Database from "better-sqlite3";
import {
  type AssistMode,
  type LocalProfile,
  type SessionProfile,
  type StyleLevel,
} from "../../shared/types.js";

interface SettingsRow {
  owner_name: string;
  owner_avatar_id: string;
  owner_avatar_data: string;
  default_reveal_message: string;
  model_mode: string;
  ai_style_enabled: number;
  analysis_enabled: number;
  style_level: string;
}

// 头像清单来自 shared/avatars.ts，前端下拉与这里的服务端校验共用同一份。

const DEFAULTS: SettingsRow = {
  owner_name: "A",
  owner_avatar_id: DEFAULT_AVATAR_ID,
  owner_avatar_data: "",
  default_reveal_message: "惊不惊喜——刚才跟你聊天的其实是个活人。",
  model_mode: config.assistMode,
  ai_style_enabled: 1,
  analysis_enabled: 1,
  style_level: "明显",
};

const MODES: AssistMode[] = ["manual", "rules", "user_model"];
const STYLE_LEVELS: StyleLevel[] = ["轻微", "明显", "浓郁"];

export interface AssistSettings {
  mode: AssistMode;
  aiStyleEnabled: boolean;
  analysisEnabled: boolean;
  styleLevel: StyleLevel;
}

// 阶段4 说明（PRD §16.5）：设置表里**不建** `ai_style_skill_path` / `analysis_skill_path` 两列。
// Skill 路径的唯一权威是 config/skills.json；入库会造出第二个真值，还给「前端能改路径」开门
// （§9.2/§24.4 明令禁止 B 侧影响路径）。生效路径改由 /api/local/status 与 runtime-manifest 暴露。
//
// 模式与开关是设置，可以落库（记住上次选择）；**模型密钥不行**，见 src/model/credentials.ts（§9.4）。
export class SettingsRepository {
  constructor(private readonly db: Database.Database) {}

  private read(): SettingsRow {
    const row = this.db
      .prepare(`SELECT * FROM local_settings WHERE id = 1`)
      .get() as SettingsRow | undefined;
    if (row) return row;
    this.db
      .prepare(
        `INSERT INTO local_settings (id, owner_name, owner_avatar_id, owner_avatar_data,
            default_reveal_message, model_mode, ai_style_enabled, analysis_enabled, style_level, updated_at)
         VALUES (1, @owner_name, @owner_avatar_id, @owner_avatar_data,
            @default_reveal_message, @model_mode, @ai_style_enabled, @analysis_enabled, @style_level, @updated_at)`,
      )
      .run({ ...DEFAULTS, updated_at: new Date().toISOString() });
    return DEFAULTS;
  }

  private write(patch: Partial<SettingsRow>): SettingsRow {
    const current = this.read();
    const next: SettingsRow = { ...current, ...patch };
    this.db
      .prepare(
        `INSERT INTO local_settings (id, owner_name, owner_avatar_id, owner_avatar_data,
            default_reveal_message, model_mode, ai_style_enabled, analysis_enabled, style_level, updated_at)
         VALUES (1, @owner_name, @owner_avatar_id, @owner_avatar_data,
            @default_reveal_message, @model_mode, @ai_style_enabled, @analysis_enabled, @style_level, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           owner_name = @owner_name,
           owner_avatar_id = @owner_avatar_id,
           owner_avatar_data = @owner_avatar_data,
           default_reveal_message = @default_reveal_message,
           model_mode = @model_mode,
           ai_style_enabled = @ai_style_enabled,
           analysis_enabled = @analysis_enabled,
           style_level = @style_level,
           updated_at = @updated_at`,
      )
      .run({
        owner_name: next.owner_name,
        owner_avatar_id: next.owner_avatar_id,
        owner_avatar_data: next.owner_avatar_data,
        default_reveal_message: next.default_reveal_message,
        model_mode: next.model_mode,
        ai_style_enabled: next.ai_style_enabled,
        analysis_enabled: next.analysis_enabled,
        style_level: next.style_level,
        updated_at: new Date().toISOString(),
      });
    return next;
  }

  get(): LocalProfile {
    return toProfile(this.read());
  }

  save(profile: LocalProfile): LocalProfile {
    const next = this.write({
      owner_name: profile.ownerName.trim(),
      owner_avatar_id: isAvatarId(profile.ownerAvatarId)
        ? profile.ownerAvatarId
        : DEFAULTS.owner_avatar_id,
      // 上传图不过形状闸就当没传（不会拿它存任意字符串再发给 B）；想换回内置头像就传空串。
      owner_avatar_data: sanitizeAvatarData(profile.ownerAvatarData),
      default_reveal_message: profile.defaultRevealMessage.trim(),
    });
    return toProfile(next);
  }

  assist(): AssistSettings {
    const row = this.read();
    return {
      mode: (MODES as string[]).includes(row.model_mode)
        ? (row.model_mode as AssistMode)
        : "rules",
      aiStyleEnabled: row.ai_style_enabled === 1,
      analysisEnabled: row.analysis_enabled === 1,
      styleLevel: (STYLE_LEVELS as string[]).includes(row.style_level)
        ? (row.style_level as StyleLevel)
        : "明显",
    };
  }

  saveAssist(patch: Partial<AssistSettings>): AssistSettings {
    const current = this.assist();
    const next: Partial<SettingsRow> = {};
    if (patch.mode !== undefined)
      next.model_mode = (MODES as string[]).includes(patch.mode)
        ? patch.mode
        : current.mode;
    if (patch.aiStyleEnabled !== undefined)
      next.ai_style_enabled = patch.aiStyleEnabled ? 1 : 0;
    if (patch.analysisEnabled !== undefined)
      next.analysis_enabled = patch.analysisEnabled ? 1 : 0;
    if (patch.styleLevel !== undefined)
      next.style_level = (STYLE_LEVELS as string[]).includes(patch.styleLevel)
        ? patch.styleLevel
        : current.styleLevel;
    return toAssist(this.write(next));
  }

  // 创建会话时把身份快照到会话行：之后 A 改设置不影响已发出去的链接（PRD §16.2）。
  // aiName/avatarId/openingMessage 属于「创建窗口」每次填的内容，不落在设置表里（PRD §7.1 §16.4）。
  snapshotForSession(input: {
    aiName: string;
    avatarId: string;
    avatarData?: string;
    openingMessage: string;
    revealMessage?: string;
  }): SessionProfile {
    const settings = this.get();
    return {
      aiName: input.aiName,
      avatarId: isAvatarId(input.avatarId) ? input.avatarId : DEFAULT_AVATAR_ID,
      // 假 AI 的上传头像：不过形状闸就当没传（空串），B 端会退回打包进去的默认图。
      avatarData: sanitizeAvatarData(input.avatarData),
      openingMessage: input.openingMessage,
      revealMessage: (
        input.revealMessage ?? settings.defaultRevealMessage
      ).trim(),
      ownerName: settings.ownerName,
      ownerAvatarId: settings.ownerAvatarId,
      ownerAvatarData: settings.ownerAvatarData,
    };
  }
}

function toProfile(row: SettingsRow): LocalProfile {
  return {
    ownerName: row.owner_name,
    ownerAvatarId: row.owner_avatar_id,
    ownerAvatarData: row.owner_avatar_data ?? "",
    defaultRevealMessage: row.default_reveal_message,
  };
}

function toAssist(row: SettingsRow): AssistSettings {
  return {
    mode: (MODES as string[]).includes(row.model_mode)
      ? (row.model_mode as AssistMode)
      : "rules",
    aiStyleEnabled: row.ai_style_enabled === 1,
    analysisEnabled: row.analysis_enabled === 1,
    styleLevel: (STYLE_LEVELS as string[]).includes(row.style_level)
      ? (row.style_level as StyleLevel)
      : "明显",
  };
}

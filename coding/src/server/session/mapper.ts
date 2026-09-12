import { sanitizeAvatarData } from "../../shared/avatars.js";
import type {
  ChatMessage,
  RevealInfo,
  SessionSummary,
} from "../../shared/types.js";
import { config } from "../config.js";
import { maskBlockedContent } from "../security/content-filter.js";
import type { SessionRow } from "./repository.js";

function addMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

// 旧版本（阶段1）创建的会话行没有阶段2 的新列，读到时按 created_at 推算，
// 保证 mapper 对两种行都能产出完整对象（正常路径下 create() 一定会写入这两列）。
function deadlineOf(row: SessionRow): string {
  return (
    row.reveal_deadline_at ??
    addMs(row.created_at, config.timeLimitMinutes * 60_000)
  );
}

function expiryOf(row: SessionRow): string {
  return (
    row.expires_at ??
    addMs(row.created_at, config.sessionExpiryHours * 3_600_000)
  );
}

export function toSessionSummary(row: SessionRow): SessionSummary {
  return {
    id: row.id,
    state: row.state,
    revealState: row.reveal_state,
    revealReason: row.reveal_reason,
    revealedAt: row.revealed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revealDeadlineAt: deadlineOf(row),
    expiresAt: expiryOf(row),
    timeLimitMinutes: config.timeLimitMinutes,
    lastOwnerHeartbeatAt: row.last_owner_heartbeat_at ?? null,
    // 阶段3：链接路径由 id 推导（基址属于隧道，不属于会话）；作废标记是会话行上的事实。
    publicPath: `/s/${row.id}`,
    linkInvalidatedAt: row.link_invalidated_at ?? null,
    linkInvalidatedReason: row.link_invalidated_reason ?? null,
    profile: {
      aiName: row.ai_name ?? "",
      avatarId: row.avatar_id ?? "",
      // 读时再过一道形状闸（写时已经过）：库里存的东西不可信，老库这一列可能压根没有。
      avatarData: sanitizeAvatarData(row.ai_avatar_data),
      openingMessage: row.opening_message ?? "",
      revealMessage: row.reveal_message ?? "",
      ownerName: row.owner_name ?? "",
      ownerAvatarId: row.owner_avatar_id ?? "",
      // 老库里的会话没这一列（建列前就存在的行）：退回内置头像，不当成错误。
      ownerAvatarData: sanitizeAvatarData(row.owner_avatar_data),
    },
  };
}

/**
 * B 侧消息视图（PRD §8.3：B 的响应里不得出现模式、Skill 名称/哈希、上游错误、processId）。
 * analysisSummary **要**给 —— 它就是设计给 B 读的那段「可分析过程」（§6.5）；
 * assist 元信息只服务 A 的「这条是生成的还是我手打的」，用剔除而不是置空，字段整个不出现。
 */
export function toPublicMessage(message: ChatMessage): ChatMessage {
  const { assist: _assist, ...rest } = message;
  return {
    ...rest,
    body: maskBlockedContent(message.body).text,
    analysisSummary: message.analysisSummary
      ? maskBlockedContent(message.analysisSummary).text
      : null,
  };
}

// 揭晓信息只在 reveal_state === REVEALED 时才构造；未揭晓时返回 null，
// 免得 A 的真实身份通过某个忘记判断的响应漏给 B（PRD §5.1）。
export function toRevealInfo(row: SessionRow): RevealInfo | null {
  if (row.reveal_state !== "REVEALED") return null;
  return {
    state: row.reveal_state,
    reason: row.reveal_reason ?? "OWNER_ACTION",
    ownerName: maskBlockedContent(row.owner_name ?? "").text,
    // PRD §17.2 揭晓示例里的 avatarId 指 A 自己的头像编号（内置头像），不是虚构 AI 的头像。
    // avatarData 同一个道理：A 上传了自己那张脸时，B 看到的就该是它（空串退回内置）。
    avatarId: row.owner_avatar_id ?? "",
    avatarData: sanitizeAvatarData(row.owner_avatar_data),
    message: maskBlockedContent(row.reveal_message ?? "").text,
    revealedAt: row.revealed_at,
  };
}

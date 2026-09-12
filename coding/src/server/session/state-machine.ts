import type {
  PendingMessageState,
  RevealReason,
  RevealState,
  SessionState,
} from "../../shared/types.js";

export class InvalidTransitionError extends Error {
  constructor(from: string, to: string, machine: string) {
    super(`Invalid ${machine} transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

// 会话状态机（PRD §26 / 阶段一开发文档 §六）
const SESSION_TRANSITIONS: Record<SessionState, SessionState[]> = {
  STARTING: ["WAITING", "EXPIRED"],
  WAITING: ["ACTIVE", "CLOSING_GRACE", "EXPIRED"],
  ACTIVE: ["CLOSING_GRACE", "EXPIRED"],
  CLOSING_GRACE: ["CLOSED", "ACTIVE"],
  CLOSED: [],
  EXPIRED: [],
};

export function assertValidSessionTransition(
  from: SessionState,
  to: SessionState,
): void {
  if (from === to) return;
  const allowed = SESSION_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new InvalidTransitionError(from, to, "session");
  }
}

// 揭示状态机：HIDDEN -> REVEALED 单向，不可逆。
const REVEAL_TRANSITIONS: Record<RevealState, RevealState[]> = {
  HIDDEN: ["REVEALED"],
  REVEALED: [],
};

export function assertValidRevealTransition(
  from: RevealState,
  to: RevealState,
): void {
  // 揭示是单向不可逆操作：即使目标状态与当前状态相同（重复揭示），也必须视为非法，
  // 否则会静默覆盖 revealed_at，且路由层依赖此处抛错来返回 409 ALREADY_REVEALED。
  const allowed = REVEAL_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new InvalidTransitionError(from, to, "reveal");
  }
}

export const VALID_REVEAL_REASONS: RevealReason[] = [
  "ROUND_LIMIT",
  "TIME_LIMIT",
  "OWNER_ACTION",
];

// pending 消息状态机。阶段1手动模式下 GENERATING 不会被触发，仅保留状态位供阶段4复用。
const PENDING_TRANSITIONS: Record<PendingMessageState, PendingMessageState[]> =
  {
    IDLE: ["WAITING_A"],
    WAITING_A: ["GENERATING", "READY", "DROPPED"],
    GENERATING: ["READY", "DROPPED"],
    READY: ["SENDING", "DROPPED"],
    SENDING: ["DELIVERED", "DROPPED"],
    DELIVERED: [],
    DROPPED: [],
  };

export function assertValidPendingTransition(
  from: PendingMessageState,
  to: PendingMessageState,
): void {
  if (from === to) return;
  const allowed = PENDING_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new InvalidTransitionError(from, to, "pending-message");
  }
}

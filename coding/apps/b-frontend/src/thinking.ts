// 阶段4：「可分析过程」的展示节奏（PRD §6.4 §7.4）。
// 这一段的存在感全靠节奏：秒出全文＝告诉对方这是复制粘贴的。

/** 先愣一下：像模型真的在算。 */
export const THINKING_LEAD_MS = 700;
/** 逐字打出的速度上限：短摘要按这个速度爬，看得清、也像真的在算。 */
export const TYPE_CHAR_MS = 45;
/** 逐字打出的速度下限：再快就没有"打出来"的感觉了。 */
export const TYPE_CHAR_FLOOR_MS = 16;
/** 打字段想要占的总时长：摘要变长（最长 300 字）之后不能按 45ms/字慢慢爬，
 *  那样一条要 13 秒，对方早跑了；按总时长倒推每字耗时，稳定在 5 秒上下。 */
export const TYPING_TARGET_MS = 5000;

/** 这一个字符该用多少毫秒打完。 */
export function typeCharMs(text: string): number {
  const n = Math.max(text.length, 1);
  return Math.min(TYPE_CHAR_MS, Math.max(TYPE_CHAR_FLOOR_MS, Math.round(TYPING_TARGET_MS / n)));
}
/** 打完之后停留一会儿再自动折起来，给对方一个「这就是它刚写出来的」的错觉。 */
export const THINKING_HOLD_MS = 1200;

export function typingDurationMs(text: string): number {
  return THINKING_LEAD_MS + text.length * typeCharMs(text);
}

/** 整条过程播放完（含折叠前停留）大概要多久：揭晓弹窗要等它。 */
export function thinkingTotalMs(text: string): number {
  return typingDurationMs(text) + THINKING_HOLD_MS;
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}

// 刷新页面不该把已经看过的思考过程再放一遍（§5.3 的「只播一次」同理用在揭晓弹窗上）。
const seenKey = (sessionId: string, messageId: string) =>
  `aiwindow_thinking_seen:${sessionId}:${messageId}`;

export function hasSeenThinking(sessionId: string, messageId: string): boolean {
  try {
    return window.sessionStorage.getItem(seenKey(sessionId, messageId)) === "1";
  } catch {
    return false;
  }
}

export function markThinkingSeen(sessionId: string, messageId: string): void {
  try {
    window.sessionStorage.setItem(seenKey(sessionId, messageId), "1");
  } catch {
    // 隐私模式下写不进去，最多是多播一次动画，不影响功能
  }
}

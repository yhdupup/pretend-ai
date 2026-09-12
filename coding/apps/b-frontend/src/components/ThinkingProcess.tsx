import { useEffect, useRef, useState } from "react";
import {
  THINKING_LEAD_MS,
  THINKING_HOLD_MS,
  markThinkingSeen,
  prefersReducedMotion,
  typeCharMs,
} from "../thinking";

interface Props {
  sessionId: string;
  messageId: string;
  text: string;
  /** 刷新页面时这条已经看过了：直接给成品，不再重播一遍打字机。 */
  instant?: boolean;
  /** 思考演出结束后通知消息气泡展示正文。 */
  onComplete?: () => void;
}

// B 侧的「可分析过程」块。三档状态：
// thinking（正在整理思路）→ typing（逐字打出）→ done（全文 + 可折叠）。
// 注意这里没有任何「AI 在想什么」的真实信息：内容就是 A 那一段摘要（PRD §6.5），
// 组件只负责让它看起来像是一步步生成的。
export default function ThinkingProcess({
  sessionId,
  messageId,
  text,
  instant,
  onComplete,
}: Props) {
  const [phase, setPhase] = useState<"thinking" | "typing" | "done">(
    instant ? "done" : "thinking",
  );
  const [shown, setShown] = useState(instant ? text : "");
  // PRD §7.4.3：播完自动折叠。刷新回来的（instant）是人家看过的，直接给折叠态。
  const [collapsed, setCollapsed] = useState(!!instant);
  const leadRef = useRef<number | null>(null);
  const stepRef = useRef<number | null>(null);
  const holdRef = useRef<number | null>(null);
  const onCompleteRef = useRef(onComplete);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  useEffect(() => {
    if (instant || prefersReducedMotion()) {
      setPhase("done");
      setShown(text);
      // 关掉动效的人也一样不该被一段收不起来的摘要占住眼睛（§7.4.3）。
      setCollapsed(true);
      markThinkingSeen(sessionId, messageId);
      onCompleteRef.current?.();
      return;
    }
    const chars = Array.from(text); // 按码点切，emoji 不会被劈成半个
    leadRef.current = window.setTimeout(() => {
      setPhase("typing");
      let i = 0;
      stepRef.current = window.setInterval(() => {
        i += 1;
        setShown(chars.slice(0, i).join(""));
        if (i < chars.length) return;
        if (stepRef.current) window.clearInterval(stepRef.current);
        holdRef.current = window.setTimeout(() => {
          setPhase("done");
          // 摘要落定就收起来，把版面让给正文（§7.4.3）；对方想再看就手动展开（§7.4.4）。
          setCollapsed(true);
          markThinkingSeen(sessionId, messageId);
          onCompleteRef.current?.();
        }, THINKING_HOLD_MS);
      }, typeCharMs(text));
    }, THINKING_LEAD_MS);
    return () => {
      for (const ref of [leadRef, stepRef, holdRef]) {
        if (ref.current) window.clearTimeout(ref.current);
      }
    };
  }, [instant, text, sessionId, messageId]);

  if (phase === "thinking") {
    return (
      <p className="thinking thinking-thinking">
        <span className="thinking-dots">正在深度思考</span>
      </p>
    );
  }

  return (
    <div className="thinking">
      <button
        type="button"
        className="thinking-head"
        onClick={() => setCollapsed((v) => !v)}
        disabled={phase !== "done"}
      >
        <span className="thinking-icon" aria-hidden="true">
          🧠
        </span>
        <span>
          {phase === "typing"
            ? "深度思考中…"
            : collapsed
              ? "展开深度思考"
              : "收起深度思考"}
        </span>
      </button>
      {!collapsed && (
        <p className="thinking-body">
          {shown}
          {phase === "typing" && <span className="thinking-caret">▌</span>}
        </p>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import {
  claimSession,
  getSession,
  pollMessages,
  previewSession,
  sendMessage,
  ApiError,
} from "../api";
import type {
  ChatMessage,
  PreviewResponse,
  RevealInfo,
} from "../../../../src/shared/types";
import { avatarEmoji, hasAvatarData } from "../../../../src/shared/avatars";
import { AI_AVATAR_IMG } from "../ai-avatar";
import {
  enterKeyAction,
  keySignalFrom,
} from "../../../../src/shared/keyboard";
import ThinkingProcess from "../components/ThinkingProcess";
import {
  hasSeenThinking,
  prefersReducedMotion,
  thinkingTotalMs,
} from "../thinking";

interface Props {
  sessionId: string;
}

const POLL_INTERVAL_MS = 3000;

// invalidated 是阶段3 加的一档：链接作废（服务端 410）和「查无此链接」（404）对 B 来说
// 不是一回事——他刚才还在聊，得告诉他是对方的连接断了，而不是他点错了地址。
type Phase =
  "loading" | "landing" | "chat" | "claimed-elsewhere" | "gone" | "invalidated";

// 揭晓原因：轮次与分钟数跟着预览下发的上限走，不写在代码里。
// （TIME_LIMIT_MINUTES 现在默认 20，而且还能用环境变量改；写死会让弹窗与实际规则不一致。）
function revealReasonText(
  reason: string | undefined,
  preview: PreviewResponse | null,
): string {
  switch (reason) {
    case "OWNER_ACTION":
      return "对方主动揭晓了自己";
    case "ROUND_LIMIT":
      return preview ? `你们聊满了 ${preview.roundLimit} 轮` : "你们聊满了轮次上限";
    case "TIME_LIMIT":
      return preview
        ? `这轮对话到了 ${preview.timeLimitMinutes} 分钟`
        : "这轮对话到了时间上限";
    default:
      return reason ?? "";
  }
}

// 同一个 B 页面只播放一次弹出动画（PRD §5.3）：用 sessionStorage 记住「这个会话已经弹过了」，
// 刷新或重新进入时直接显示已揭晓状态 + 查看入口，不再自动弹。
function seenKey(sessionId: string): string {
  return `aiwindow_reveal_seen:${sessionId}`;
}

function hasSeenReveal(sessionId: string): boolean {
  try {
    return window.sessionStorage.getItem(seenKey(sessionId)) === "1";
  } catch {
    return false;
  }
}

function markRevealSeen(sessionId: string): void {
  try {
    window.sessionStorage.setItem(seenKey(sessionId), "1");
  } catch {
    // 隐私模式下 sessionStorage 可能不可用，最多是多弹一次，不影响功能
  }
}

export default function SessionPage({ sessionId }: Props) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [reveal, setReveal] = useState<RevealInfo | null>(null);
  const [showPopup, setShowPopup] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [aiTyping, setAiTyping] = useState(false);
  const lastMessageIdRef = useRef<string | null>(null);
  const stoppedRef = useRef(false);
  const revealSeenRef = useRef(hasSeenReveal(sessionId));
  // 揭晓弹窗要等「正在整理思路」那段演完（PRD §5.3：第 10 轮先播完回复）。
  const messagesRef = useRef<ChatMessage[]>([]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // 首屏：先试着按“已绑定”读会话（刷新页面应该直接回到聊天），
  // 读不到再退回预览页让 B 自己点「开始对话」，避免一打开就把链接绑掉。
  useEffect(() => {
    stoppedRef.current = false;
    (async () => {
      try {
        const detail = await getSession(sessionId);
        if (stoppedRef.current) return;
        setPreview({
          aiName: detail.aiName,
          avatarId: detail.avatarId,
          avatarData: detail.avatarData,
          openingMessage: detail.openingMessage,
          state: detail.session.state,
          roundLimit: detail.roundLimit,
          timeLimitMinutes: detail.timeLimitMinutes,
        });
        setMessages(detail.messages);
        messagesRef.current = detail.messages;
        const last = detail.messages[detail.messages.length - 1];
        lastMessageIdRef.current = last ? last.id : null;
        if (detail.reveal) applyReveal(detail.reveal);
        setPhase("chat");
      } catch (err) {
        if (stoppedRef.current) return;
        if (err instanceof ApiError && err.status === 410) {
          setPhase("invalidated");
          return;
        }
        if (!(err instanceof ApiError) || err.status !== 404) {
          setPhase("gone");
          return;
        }
        try {
          const p = await previewSession(sessionId);
          if (stoppedRef.current) return;
          setPreview(p);
          setPhase("landing");
        } catch (previewErr) {
          if (stoppedRef.current) return;
          setPhase(
            previewErr instanceof ApiError && previewErr.status === 410
              ? "invalidated"
              : "gone",
          );
        }
      }
    })();
    return () => {
      stoppedRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  function applyReveal(info: RevealInfo) {
    setReveal(info);
    if (revealSeenRef.current) return;
    revealSeenRef.current = true;
    markRevealSeen(sessionId);
    // 先让这一轮的新消息渲染出来，再弹揭晓弹窗（PRD §5.3：第 10 轮要先播完回复）。
    // 阶段4：这一轮的回复还带着「正在整理思路」的逐字演出，弹窗得排在它后面，
    // 否则思考动画演到一半被弹窗抢走，节奏就白做了。
    const lastA = [...messagesRef.current]
      .reverse()
      .find((m) => m.sender === "A");
    const pendingThinking =
      lastA?.analysisSummary && !hasSeenThinking(sessionId, lastA.id)
        ? thinkingTotalMs(lastA.analysisSummary)
        : 0;
    window.setTimeout(() => setShowPopup(true), 600 + pendingThinking);
  }

  const poll = async () => {
    try {
      const result = await pollMessages(sessionId, lastMessageIdRef.current);
      if (result.messages.length > 0) {
        const nextMessages = [...messagesRef.current, ...result.messages];
        messagesRef.current = nextMessages;
        setMessages(nextMessages);
        const last = result.messages[result.messages.length - 1];
        if (last) lastMessageIdRef.current = last.id;
        setAiTyping(false);
      }
      if (result.reveal) applyReveal(result.reveal);
    } catch (err) {
      if (err instanceof ApiError && err.status === 410) {
        // 阶段3：公网中断超阈值，服务端已把这个链接作废并结束会话
        setPhase("invalidated");
      } else if (err instanceof ApiError && err.status === 404) {
        // 会话被 A 关闭、心跳超时或 10 小时过期：服务端已经删干净了，没有“已结束”可查
        setPhase("gone");
      }
    }
  };

  useEffect(() => {
    if (phase !== "chat") return;
    const timer = window.setInterval(() => {
      if (!stoppedRef.current) poll();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const handleClaim = async () => {
    setBusy(true);
    setError(null);
    try {
      await claimSession(sessionId);
      const detail = await getSession(sessionId);
      setMessages(detail.messages);
      messagesRef.current = detail.messages;
      const last = detail.messages[detail.messages.length - 1];
      lastMessageIdRef.current = last ? last.id : null;
      if (detail.reveal) applyReveal(detail.reveal);
      setPhase("chat");
    } catch (err) {
      if (err instanceof ApiError && err.code === "LINK_ALREADY_CLAIMED") {
        setPhase("claimed-elsewhere");
      } else if (err instanceof ApiError && err.status === 404) {
        setPhase("gone");
      } else {
        setError("连接不上这个会话了，请稍后再试。");
      }
    } finally {
      setBusy(false);
    }
  };

  const handleSend = async () => {
    const text = draft.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      const result = await sendMessage(sessionId, text);
      setDraft("");
      setMessages((prev) => [...prev, result.message]);
      lastMessageIdRef.current = result.message.id;
      setAiTyping(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 410) {
        setPhase("invalidated");
      } else if (err instanceof ApiError && err.status === 404) {
        setPhase("gone");
      } else {
        setError(
          err instanceof ApiError
            ? err.code === "MESSAGE_PENDING"
              ? "上一条还在回复中，先等等。"
              : `发送失败（${err.code}）`
            : "发送失败，请重试。",
        );
      }
    } finally {
      setBusy(false);
    }
  };

  if (phase === "loading") {
    return (
      <div className="page session-page">
        <p>加载中…</p>
      </div>
    );
  }

  if (phase === "gone") {
    return (
      <div className="page not-found-page">
        <p>会话不存在或已结束。</p>
      </div>
    );
  }

  if (phase === "invalidated") {
    return (
      <div className="page not-found-page">
        <p>这个对话已经结束了。</p>
        <p className="hint">对方的连接中断过，这条链接随之作废。</p>
      </div>
    );
  }

  if (phase === "claimed-elsewhere") {
    return (
      <div className="page not-found-page">
        <p>这个链接已经在其它设备上用过了。</p>
      </div>
    );
  }

  // 假 AI 的脸：A 创建时上传过就用那张，没上传就用打包进前端的默认图。
  // 2026-09-13 起这里不再是 avatarEmoji(preview.avatarId)——四个内置编号的下拉已经从创建窗口删掉了，
  // avatarId 这一列只作为老会话的数据留着，不再决定屏幕上画什么。
  const uploadedAiAvatar =
    preview && hasAvatarData(preview.avatarData) ? preview.avatarData : "";
  const aiAvatarSrc = uploadedAiAvatar || AI_AVATAR_IMG;

  const header = (
    <header className="chat-header">
      <div className="avatar-wrap">
        {/* 头像右边那个绿点（<i>）靠 .avatar-wrap 定位，图片换成 img 也照样挂得住 */}
        <img
          className="avatar-img"
          src={aiAvatarSrc}
          alt=""
          width={42}
          height={42}
        />
        {!reveal && <i aria-hidden="true" />}
      </div>
      <div className="chat-identity">
        <strong>{preview?.aiName ?? "AI"}</strong>
        <span className="sub">
          {reveal
            ? `已揭晓 · ${revealReasonText(reveal.reason, preview)}`
            : "AI 在线"}
        </span>
      </div>
    </header>
  );

  if (phase === "landing") {
    return (
      <div className="page session-page landing-page">
        <div className="mini-brand"><span aria-hidden="true">✦</span> AI 对话</div>
        <main className="landing-card">
          <div className="landing-doodle" aria-hidden="true">
            <svg viewBox="0 0 124 56" fill="none">
              <path d="M3 39c17-36 31 14 52-8 20-21 31 25 65-19" />
              <path d="m90 5 6 7 9-4M18 8l1 10M11 14l-8 3" />
            </svg>
          </div>
          {header}
          <span className="welcome-label">给你留了一句话</span>
          {preview?.openingMessage && (
            <p className="opening">{preview.openingMessage}</p>
          )}
          <button className="primary" onClick={handleClaim} disabled={busy}>
            {busy ? "正在连接…" : "进入对话 →"}
          </button>
          <p className="privacy-note">请别在对话中发送密码、住址等敏感信息。</p>
          {error && <p className="error">{error}</p>}
        </main>
      </div>
    );
  }

  return (
    <div className="page session-page">
      <div className="chat-shell">
      {header}

      <section className="message-list">
        {preview?.openingMessage && (
          <div className="message message-A">
            <p>{preview.openingMessage}</p>
          </div>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.id} sessionId={sessionId} message={m} />
        ))}
        {aiTyping && <p className="typing-indicator"><i /><i /><i /><span>正在回复</span></p>}
      </section>

      {reveal && !showPopup && (
        <button className="reveal-entry" onClick={() => setShowPopup(true)}>
          查看揭晓信息
        </button>
      )}

      <footer className="composer">
        {/* 一轮一问：服务端已经用 409 MESSAGE_PENDING 挡了连发，这里提前把输入框锁住，
            别让 B 打完字才被告知发不出去。 */}
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={aiTyping ? "对方正在输入…" : "输入消息"}
          disabled={busy || aiTyping}
          // PRD §5.5：组词态回车归输入法；§6.7：Enter 发送 / Shift+Enter 换行。
          // 能不能发只看跟发送按钮同一个条件，避免回车绕过 disabled 双发。
          onKeyDown={(e) => {
            const s = keySignalFrom(e);
            if (enterKeyAction(s) !== "send") return;
            e.preventDefault();
            if (!busy && !aiTyping && draft.trim()) void handleSend();
          }}
        />
        <button className="send-button"
          onClick={handleSend}
          disabled={busy || aiTyping || !draft.trim()}
        >
          <span>发送</span><b aria-hidden="true">↑</b>
        </button>
      </footer>

      {error && <p className="error">{error}</p>}
      </div>

      {showPopup && reveal && (
        <div className="reveal-overlay" role="dialog" aria-modal="true">
          {/* 遮罩不绑定点击关闭：PRD §7.5 要求不能误触关掉 */}
          <div className="reveal-popup">
            {/* A 传了自己那张脸就展示它，没传才退回内置文字头像。 */}
            {hasAvatarData(reveal.avatarData) ? (
              <img
                className="avatar-img big"
                src={reveal.avatarData}
                alt="A 的头像"
                width={64}
                height={64}
              />
            ) : (
              <span className="avatar big">{avatarEmoji(reveal.avatarId)}</span>
            )}
            <span className="reveal-kicker">谜底揭开啦</span>
            <h2>其实我是 {reveal.ownerName || "ta"}</h2>
            <p className="reason">{revealReasonText(reveal.reason, preview)}</p>
            <p className="message-text">{reveal.message}</p>
            <button className="primary" onClick={() => setShowPopup(false)}>
              知道了，继续聊天
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** 有反推内容时严格按“深度思考 → 正文”串行展示；普通消息无需等待。 */
function MessageBubble({
  sessionId,
  message,
}: {
  sessionId: string;
  message: ChatMessage;
}) {
  const hasThinking = message.sender === "A" && !!message.analysisSummary;
  const instant = hasThinking && hasSeenThinking(sessionId, message.id);
  const [showBody, setShowBody] = useState(
    !hasThinking || instant || prefersReducedMotion(),
  );

  return (
    <div className={`message message-${message.sender}`}>
      {hasThinking && (
        <ThinkingProcess
          sessionId={sessionId}
          messageId={message.id}
          text={message.analysisSummary as string}
          instant={instant}
          onComplete={() => setShowBody(true)}
        />
      )}
      {showBody && <p className={hasThinking ? "message-body-result" : undefined}>{message.body}</p>}
    </div>
  );
}

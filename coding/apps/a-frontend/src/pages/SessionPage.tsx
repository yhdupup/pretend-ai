import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  closeSession,
  confirmProcess,
  getSettings,
  getSession,
  heartbeat,
  newReplyKey,
  processDraft,
  sendReply,
  revealSession,
  type SettingsPayload,
} from "../api";
import type {
  ChatMessage,
  PendingMessageInfo,
  ProcessErrorCode,
  ProcessResponse,
  SessionSummary,
} from "../../../../src/shared/types";
import { avatarEmoji } from "../../../../src/shared/avatars";
import {
  enterKeyAction,
  keySignalFrom,
} from "../../../../src/shared/keyboard";
import {
  analysisStale,
  assistRunPayload,
  shouldShowAnalysisBox,
} from "../assist-run";
import PublicLinkCard from "../components/PublicLinkCard";
import { usePublicStatus } from "../hooks/usePublicStatus";

interface Props {
  sessionId: string;
  onExit: () => void;
}

const POLL_INTERVAL_MS = 3000;
// A 页面心跳：PRD §10 规定 5 秒一次 + 15 秒宽限期；阶段2 用 REST POST 代替 WS 应用层心跳。
const HEARTBEAT_INTERVAL_MS = 5000;

function formatCountdown(ms: number): string {
  if (ms <= 0) return "00:00";
  const total = Math.floor(ms / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

// 处理草稿失败时给 A 看的人话（PRD §6.6：失败必须让 A 知道，且绝不能动正文）。
const PROCESS_ERROR_TEXT: Record<ProcessErrorCode, string> = {
  DRAFT_EMPTY: "草稿还是空的，没什么可处理的。",
  NO_PENDING_MESSAGE: "现在没有待回复的问题。",
  MANUAL_MODE: "当前是人工模式，不生成内容。",
  // 不说「没配密钥」：密钥只是三项里的一项，缺的常常是地址或模型名（实跑撞过）。
  MODEL_NOT_CONFIGURED: "模型模式有一项还没填（地址 / 模型名 / 密钥，缺哪项看括号里），去「AI 能力」补齐。",
  // 这一码单独存在是为了不把「地址填错」说成「没配密钥」——实跑撞过，用户会反复重填同一项。
  MODEL_CONFIG_INVALID: "模型配置里有一项不对（不是密钥没填），按括号里的原因改那一项。",
  SKILL_MISSING: "Skill 文件读不到，这一轮改用人工模式：正文照常发。",
  RATE_LIMITED: "点得太快了，等几秒再试（也正好给对方留点思考感）。",
  INVALID_MODEL_OUTPUT: "这一版输出被服务端拦下了，正文保持你原来的写法。",
  // 推理模型专属：测试能通、按钮不行，就是这个原因（一个字的不需求不会把预算吃光）。
  MODEL_OUTPUT_TRUNCATED:
    "输出预算被「思考」占满了，正文没动：再点一次会自动加大预算，一直这样就把 MODEL_MAX_TOKENS 调到 2000 以上，或换不思考的模型。",
  MODEL_UNAVAILABLE: "模型调不通（鉴权或地址问题），可以先人工发出去。",
  INTERNAL_ERROR: "服务端出了点状况，正文没动，可以直接人工发送。",
  // 以下几条是路由自己的码：以前没配文案，界面上只有「处理失败。」四个字。
  GENERATION_IN_PROGRESS: "上一轮还在生成，等它一下下再点（对方也正看着「正在输入」）。",
  LINK_INVALIDATED: "这条链接已经作废了，正文没动；换新链接重新发一次。",
  NOTHING_TO_ENABLE: "AI 味和思考过程都是关着的，这一轮没什么可处理的。",
  INVALID_BODY: "这一请求没发出去（表单内容不合规矩），正文没动。",
};

/** 查文案。类型表保证「服务端有的码必须有文案」，这里兜住的是服务端哪天多吐一个码。 */
function processErrorText(code: string, fallback = "处理失败。"): string {
  const table: Record<string, string | undefined> = PROCESS_ERROR_TEXT;
  return table[code] ?? fallback;
}

const WARNING_TEXT: Record<string, string> = {
  ANALYSIS_SKIPPED:
    "摘要这一版没过自检，已留空：可以先发正文，或再点一次处理。",
  STYLE_SKIPPED: "润色那一版没过自检，正文保持你原来的写法。",
  DRAFT_TOO_SHORT: "正文只有语气词，反推不出有信息量的思路，摘要留空。",
};

// 揭晓原因说给人听的话。轮次和分钟数都从服务端载荷拿，不写在这里：
// ROUND_LIMIT / TIME_LIMIT_MINUTES 是可以改的（后者现在默认 20），
// 文案里写死「第 10 轮」「已满 10 分钟」会跟实际规则和倒计时对不上。
function revealReasonText(
  reason: string | null | undefined,
  limits: { roundLimit: number; timeLimitMinutes: number },
): string | undefined {
  switch (reason) {
    case "OWNER_ACTION":
      return "你点了「立即揭晓」";
    case "ROUND_LIMIT":
      return `已完成第 ${limits.roundLimit} 轮`;
    case "TIME_LIMIT":
      return `距创建已满 ${limits.timeLimitMinutes} 分钟`;
    default:
      return reason ?? undefined;
  }
}

export default function SessionPage({ sessionId, onExit }: Props) {
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [pending, setPending] = useState<PendingMessageInfo[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [roundCount, setRoundCount] = useState(0);
  const [roundLimit, setRoundLimit] = useState(10);
  const [draft, setDraft] = useState("");
  // 阶段4：可分析过程输入框 + 最近一次生成的结果（processId 是这条结果的凭证）。
  const [analysis, setAnalysis] = useState("");
  const [process, setProcess] = useState<ProcessResponse | null>(null);
  const [processing, setProcessing] = useState(false);
  const [assistNote, setAssistNote] = useState<{
    kind: "error" | "warn" | "ok";
    text: string;
  } | null>(null);
  const [settings, setSettings] = useState<SettingsPayload | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 阶段3：链接与公网通道状态。地址可能在重连后变，所以是轮询来的，不是创建时快照。
  // 阶段3：链接状态（卡片要用）。通道本身的开关/换地址只在首页做，聊天时不摆面板。
  const { status } = usePublicStatus();
  const [notFound, setNotFound] = useState(false);
  const [heartbeatOk, setHeartbeatOk] = useState<boolean | null>(null);
  // 服务器时间与本地时钟的差值：倒计时以服务端算出的 revealDeadlineAt 为准，
  // 只在本地对表（PRD §16.6：会话时间由服务端计算，不接受前端提交）。
  const serverOffsetMsRef = useRef(0);
  const [, setTick] = useState(0);
  const notFoundRef = useRef(false);
  const replyKeyRef = useRef<string | null>(null);

  const refresh = async () => {
    try {
      const detail = await getSession(sessionId);
      setSession(detail.session);
      setPending(detail.pending);
      setMessages(detail.messages);
      setRoundCount(detail.roundCount);
      setRoundLimit(detail.roundLimit);
      serverOffsetMsRef.current = Date.parse(detail.serverTime) - Date.now();
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        notFoundRef.current = true;
        setNotFound(true);
      }
    }
  };

  useEffect(() => {
    getSettings()
      .then(setSettings)
      .catch(() => {
        // 拿不到设置时按人工模式渲染（不显示生成按钮），不能让页面报错挡住聊天。
        setSettings(null);
      });
  }, []);

  // 换问题了：上一次生成的结果必须作废，否则会把上一问的摘要带进这一问（PRD §6.6）。
  useEffect(() => {
    const first = pending[0]?.id ?? null;
    if (first !== pendingId) {
      setPendingId(first);
      setProcess(null);
      setAnalysis("");
      setAssistNote(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(() => {
      if (!notFoundRef.current) refresh();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // 心跳。独立于消息轮询：A 只是把页面开着，也应该维持会话存活。
  useEffect(() => {
    let stopped = false;
    const beat = async () => {
      try {
        await heartbeat(sessionId);
        if (!stopped) setHeartbeatOk(true);
      } catch (err) {
        if (stopped) return;
        if (err instanceof ApiError && err.status === 404) {
          notFoundRef.current = true;
          setNotFound(true);
        } else {
          setHeartbeatOk(false);
        }
      }
    };
    beat();
    const timer = window.setInterval(beat, HEARTBEAT_INTERVAL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [sessionId]);

  // 倒计时每秒重绘一次（数据本身还是 3 秒一轮询刷新）。
  useEffect(() => {
    const timer = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const assistOn = !!settings && settings.assist.mode !== "manual";
  // §6.6 闸门两种「过程与正文对不上」：① 处理之后又改了正文；② 框里有一段过程，
  // 但它没跟当前这份处置绑定（改过过程文本，或刚点完「处置正文」把过程顶掉了）。
  // 第 ② 种是 2026-09-12「B 看不到思考过程」那条的根因：过去只看 ①，于是被顶掉的过程
  // 既不报警也不拦发送，界面上一段还在、发出去的 processId 里却是空的。
  const stale =
    (!!process &&
      !!process.analysisSummary &&
      process.reply !== draft.trim()) ||
    analysisStale({ analysis, process });
  const canSend = !processing && !!draft.trim() && !stale;
  // 两个按钮同一套门槛：得有一条没回答的提问（§9.3 的锚点）、有正文、不是人工模式。
  const assistDisabled =
    processing ||
    !draft.trim() ||
    !assistOn ||
    pending.length === 0;
  const assistTitle =
    pending.length === 0
      ? "要拿对方真问题当锚点：对方问一句就能点"
      : !draft.trim()
        ? "先写一句正文，才有东西可处理"
        : undefined;

  // 这一页不再自带「就地改设置」的小控制器（档位下拉已隐藏），所以原先那个
  // 先改界面再发请求、失败滚回来的 toggleAssist 一并撤了 —— 留着就是死代码，
  // 而它服务的「点档位就落库」通路已经不在界面上。模式与开关的入口在首页 AI 能力板块。

  // 一次调用要哪一项，界面上就只传那一项的开关：两个按钮分开，点「处置正文」不会顺手改摘要。
  // 也不传 analysisManual —— 那是 A 手写过程的通道，走「确认这条摘要」；按「深度反推」就是要重新生成。
  const runAssist = async (kind: "polish" | "analysis") => {
    if (!pending[0] || !settings) return;
    setProcessing(true);
    setAssistNote(null);
    try {
      const result = await processDraft(sessionId, {
        ...assistRunPayload(kind, draft, settings.assist.styleLevel),
        mode: settings.assist.mode,
      });
      setProcess(result);
      if (kind === "polish") setDraft(result.reply);
      if (result.analysisSummary) setAnalysis(result.analysisSummary);
      // 服务端只发固定的降级码；模型自己也会往 warnings 里塞自定义码（见过 FACT_MISSING_IN_DRAFT），
      // 那种没人话翻译，至少标上来源，别让 A 以为是界面坏了。
      const warnings = result.warnings.map(
        (w) => WARNING_TEXT[w] ?? `模型提示：${w}`,
      );
      setAssistNote(
        warnings.length
          ? { kind: "warn", text: warnings.join("；") }
          : {
              kind: "ok",
              text:
                kind === "polish"
                  ? `正文已按${settings.assist.styleLevel}档处理，检查完再发。`
                  : "分析过程生成好了，可以直接改。",
            },
      );
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "INTERNAL_ERROR";
      // 失败时绝不覆盖 A 的草稿——这条是 PRD §6.6 的硬约束，UI 也要照做。
      setAssistNote({
        kind: "error",
        text: `${processErrorText(code)}${err instanceof ApiError && err.detail ? `（${err.detail}）` : ""}`,
      });
    } finally {
      setProcessing(false);
    }
  };

  // 改过正文但不想重新生成：显式确认「这条摘要还配得上我改后的正文」。
  // 没有 process 时（A 完全手写、一次按钮都没点）也要有出路：
  // 发送接口的 analysisSummary 不从前端传（sessions.ts:40，防页面改出任意摘要），
  // 所以这里走一次 /process + analysisManual ——它本来就是「以 A 写的为准、但闸口一个不少」那条通道。
  const handleConfirm = async () => {
    setProcessing(true);
    try {
      if (!process) {
        const result = await processDraft(sessionId, {
          draft,
          aiStyleEnabled: false,
          analysisEnabled: true,
          analysisManual: analysis.trim(),
          mode: settings?.assist.mode,
          styleLevel: settings?.assist.styleLevel,
        });
        setProcess(result);
        setAnalysis(result.analysisSummary);
        setAssistNote({
          kind: "ok",
          text: "已确认，可以发送。这段过程是你写的，已按同一套输出闸验过一遍。",
        });
        return;
      }
      const result = await confirmProcess(sessionId, process.processId, {
        reply: draft.trim(),
        analysisSummary: analysis.trim(),
      });
      setProcess({
        ...process,
        reply: draft.trim(),
        analysisSummary: result.analysisSummary,
      });
      setAnalysis(result.analysisSummary);
      setAssistNote({
        kind: "ok",
        text: "已确认，可以发送。这条摘要会跟着当前正文一起出去。",
      });
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "INTERNAL_ERROR";
      setAssistNote({
        kind: "error",
        text: `${
          code === "INVALID_MODEL_OUTPUT"
            ? "这段过程没过自检（内部用词、Markdown 或太长），改一下再确认。"
            : processErrorText(code, "确认失败。")
        }`,
      });
    } finally {
      setProcessing(false);
    }
  };

  const handleReply = async () => {
    const text = draft.trim();
    if (!text || stale) return;
    setBusy(true);
    setError(null);
    // 同一次发送（含失败重试）复用同一个 key；成功后清空，下一条重新生成。
    const key = replyKeyRef.current ?? newReplyKey(sessionId);
    replyKeyRef.current = key;
    try {
      const result = await sendReply(
        sessionId,
        text,
        key,
        process?.processId ?? null,
      );
      replyKeyRef.current = null;
      setDraft("");
      setProcess(null);
      setAnalysis("");
      setAssistNote(
        result.contentFilter?.applied
          ? {
              kind: "warn",
              text: `已按安全规则隐藏 ${result.contentFilter.matchedCount} 类敏感词，B 看不到被屏蔽的内容。`,
            }
          : null,
      );
      setRoundCount(result.roundCount);
      setSession(result.session);
      await refresh();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `发送失败（${err.code}），可再点一次重试。`
          : "发送失败，请重试。",
      );
    } finally {
      setBusy(false);
    }
  };

  const handleReveal = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await revealSession(sessionId);
      setSession(result.session);
      await refresh();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `揭晓失败（${err.code}）`
          : "揭晓失败，请重试。",
      );
    } finally {
      setBusy(false);
    }
  };

  const handleClose = async () => {
    if (
      !window.confirm(
        "结束并清理本次会话？B 那边的链接会立刻失效，聊天记录不保留。",
      )
    )
      return;
    setBusy(true);
    try {
      await closeSession(sessionId);
    } catch {
      // 已经清理过的会话再点也会 404，统一按“已结束”处理
    }
    notFoundRef.current = true;
    setNotFound(true);
    setBusy(false);
  };

  if (notFound) {
    return (
      <div className="page session-page">
        <p>
          会话已结束并清理（不存在、被 A 关闭、A 心跳超时或超过 10
          小时都会走到这里）。
        </p>
        <button onClick={onExit}>返回首页</button>
      </div>
    );
  }

  const remainingMs = session
    ? Date.parse(session.revealDeadlineAt) -
      (Date.now() + serverOffsetMsRef.current)
    : 0;
  const roundsLeft = Math.max(0, roundLimit - roundCount);

  return (
    <div className="page session-page">
      <header className="session-topbar">
        <button className="back-button" onClick={onExit}>← 返回工作台</button>
        <div className="session-title">
          <span className="eyebrow">幕后控制室</span>
          <strong>{session?.profile.aiName ?? "对话进行中"}</strong>
        </div>
        <div className="live-state" title="控制端每 5 秒保持一次连接">
          <i aria-hidden="true" />
          {heartbeatOk === null ? "连接中" : heartbeatOk ? "控制端在线" : "连接不稳定"}
        </div>
      </header>

      <div className="session-dashboard">
      <aside className="session-sidebar">
        <section className="counters">
        <div>
          <span className="counter-label">轮次</span>
          <strong>
            {roundCount} / {roundLimit}
          </strong>
          <span className="hint">还差 {roundsLeft} 轮自动揭晓</span>
        </div>
        <div>
          <span className="counter-label">倒计时</span>
          <strong>{formatCountdown(remainingMs)}</strong>
          <span className="hint">到点后无论有没有新消息都会揭晓</span>
        </div>
        <div>
          <span className="counter-label">揭晓</span>
          <strong>
            {session?.revealState === "REVEALED" ? "已揭晓" : "未揭晓"}
          </strong>
          {session?.revealState === "REVEALED" && (
            <span className="hint">
              {revealReasonText(session?.revealReason, {
                roundLimit,
                timeLimitMinutes: session.timeLimitMinutes,
              }) ?? session?.revealReason}
            </span>
          )}
        </div>
          <div className="counter-actions">
            <button
              onClick={handleReveal}
              disabled={busy || session?.revealState === "REVEALED"}
            >
              立即揭晓
            </button>
            <button onClick={handleClose} disabled={busy} className="ghost">
              结束并清理
            </button>
          </div>
        </section>

      {session && (
        <>
          <PublicLinkCard
            status={status}
            publicPath={session.publicPath}
            linkInvalidatedAt={session.linkInvalidatedAt}
          />
          {/* 聊天时不再占一整块「公网通道」面板（作者 2026-09-12）：
              这里只需要链接卡片；通道坏了卡片会自己说，开关回首页。 */}
        </>
      )}

      {session?.revealState === "REVEALED" && (
        <section className="reveal-preview">
          <h2>B 现在看到的</h2>
          <p>
            {avatarEmoji(session.profile.ownerAvatarId)}{" "}
            {session.profile.ownerName || "（没填称呼）"} ·{" "}
            {session.profile.revealMessage}
          </p>
        </section>
      )}
      </aside>

      <main className="conversation-panel">

      {pending.length > 0 && (
        <section className="pending-list">
          <h2>待处理</h2>
          <ul>
            {pending.map((p) => (
              <li key={p.id}>
                [{p.state === "GENERATING" ? "处理中" : p.state}] {p.body}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="message-list">
        {messages.length === 0 && (
          <div className="empty-chat">
            <span aria-hidden="true">↝</span>
            <strong>链接已经准备好</strong>
            <p>把左侧链接发出去。对方开口后，消息会出现在这里。</p>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`message message-${m.sender}`}>
            <strong>{m.sender}</strong>
            <p>{m.body}</p>
            {/* A 侧看得见模式痕迹（PRD §7.2），B 侧只有摘要本身。 */}
            {m.analysisSummary && (
              <p className="message-analysis">过程：{m.analysisSummary}</p>
            )}
            {m.assist && (
              <p className="message-meta">
                {m.assist.mode === "rules"
                  ? "本地规则"
                  : m.assist.mode === "user_model"
                    ? "我的模型"
                    : "人工"}
                {m.assist.styleLevel ? ` · ${m.assist.styleLevel}` : ""}
                {m.assist.scene ? ` · ${m.assist.scene}` : ""}
              </p>
            )}
          </div>
        ))}
      </section>

      <footer>
        {/* 两项能力拆成两个按钮，档位夹在中间（作者 2026-09-12：上一版一个按钮干两件事，
            改名之后反而把“处置正文”弄不见了）。这一行**常驻**：没提问时两个按钮灰着并说清原因。 */}
        {settings && (
          <div className="assist-row">
            <button
              className="chip"
              onClick={() => void runAssist("polish")}
              disabled={assistDisabled}
              title={assistTitle}
            >
              {processing ? "处理中…" : "处置正文"}
            </button>
            {/* 档位下拉已从这一行拿掉（作者 2026-09-12）：两个按钮拆开后，它是这一排里
                唯一的「设置项」夹在两个「动作」中间，看着像第三个按钮，而它改的是下面
                那句「正文已按明显档处理」的档位。要改去首页 AI 能力 → 生成设置，
                那儿改完这里照常生效（默认记住上次选择，PRD §6.6）。
                不留 toggleAssist({styleLevel}) 的残枝，也不留 STYLE_LEVELS / StyleLevel 的 import。 */}
            <button
              className="chip"
              onClick={() => void runAssist("analysis")}
              disabled={assistDisabled}
              title={assistTitle}
            >
              {processing ? "反推中…" : "深度反推"}
            </button>
            <span className="hint">
              {pending.length === 0
                ? "对方问一句之后这两个按钮就能点：左边改正文，右边把下面「展示给对方的分析过程」填好"
                : settings.assist.mode === "rules"
                  ? "本地规则：离线、不花钱"
                  : settings.assist.mode === "user_model"
                    ? "我的模型：真会发一次请求"
                    : "人工模式：去首页「AI 能力」里换成规则或模型"}
            </span>
          </div>
        )}

        {/* PRD §6.5：分析摘要框在最终回复框**上方**，标签写「展示给对方的分析过程」。 */}
        {settings &&
          shouldShowAnalysisBox({
            analysisEnabled: settings.assist.analysisEnabled,
            analysis,
            hasPending: pending.length > 0,
          }) && (
          <label className="analysis-block">
            <span className="analysis-label">展示给对方的分析过程</span>
            <textarea
              className="analysis-input"
              value={analysis}
              onChange={(e) => setAnalysis(e.target.value)}
              placeholder="选填。这段会被对方当成「你是怎么想到这个答案的」逐字看到；留空则这一条不显示过程。点「深度反推」会自动生成一版，你可以随便改，改完必须点「确认这条摘要」才会跟着发出去。"
              maxLength={settings.limits.maxAnalysisChars}
              disabled={busy || processing}
            />
          </label>
        )}

        <textarea
          className="draft-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={
            processing
              ? "正在生成，可以先想一下要不要改…"
              : "回复内容（B 看到的正文）"
          }
          disabled={busy || processing}
          // PRD §6.7：Enter 发送、Shift+Enter 换行、组词态回车不发送。
          // 上面那个「展示给对方的分析过程」框不绑这个：它是编辑器，回车就该换行。
          onKeyDown={(e) => {
            const s = keySignalFrom(e);
            if (enterKeyAction(s) !== "send") return;
            e.preventDefault();
            if (!busy && canSend) void handleReply();
          }}
        />


        {stale && (
          <p className="assist-warning">
            {process?.analysisSummary
              ? "正文改过了，这段摘要需要对不上号才能发："
              : "「展示给对方的分析过程」里这段还没跟当前正文绑定，发出去对方看不到它："}
            <button
              className="mini"
              onClick={() => void runAssist("analysis")}
              disabled={processing || pending.length === 0}
            >
              重新反推
            </button>
            <button className="mini" onClick={handleConfirm} disabled={processing}>
              确认这条摘要
            </button>
          </p>
        )}
        {assistNote && (
          <p
            className={
              assistNote.kind === "error"
                ? "assist-error"
                : assistNote.kind === "warn"
                  ? "assist-warning"
                  : "assist-ok"
            }
          >
            {assistNote.text}
          </p>
        )}

        <button className="primary" onClick={handleReply} disabled={busy || !canSend}>
          {stale ? "先处理摘要不一致" : "发送给对方 →"}
        </button>
      </footer>

      {error && <p className="error">{error}</p>}
      </main>
      </div>
    </div>
  );
}

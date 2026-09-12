import { useEffect, useState } from "react";
import { createSession, getProfile, saveProfile, ApiError } from "../api";
import AssistPanel from "../components/AssistPanel";
import PublicStatusPanel from "../components/PublicStatusPanel";
import { usePublicStatus } from "../hooks/usePublicStatus";
import { DEFAULT_AVATAR_ID } from "../../../../src/shared/avatars";
import OwnerAvatarPicker from "../components/OwnerAvatarPicker";
import AvatarPicker from "../components/AvatarPicker";

interface Props {
  onCreated: (sessionId: string) => void;
}

// 创建窗口（PRD §7.1 §7.3）：A 在这里填「我是谁」和「假 AI 是谁」，
// 这些值会被快照到会话行上，之后改这里不会影响已经发出去的链接。
export default function HomePage({ onCreated }: Props) {
  const [ownerName, setOwnerName] = useState("");
  const [ownerAvatarId, setOwnerAvatarId] = useState<string>(DEFAULT_AVATAR_ID);
  // A 自己上传的身份头像（data URL，空串=用内置）。建会话时快照到会话行，之后换图不影响已发链接。
  const [ownerAvatarData, setOwnerAvatarData] = useState("");
  const [aiName, setAiName] = useState("小雷 AI");
  // 假 AI 的头像：空串 = 用打包进去的那张默认图（/ai-avatar.jpg），非空 = A 自己上传/粘贴的。
  const [aiAvatarData, setAiAvatarData] = useState("");
  const [openingMessage, setOpeningMessage] =
    useState("你好，我是小雷 AI，有什么想问的？");
  const [revealMessage, setRevealMessage] = useState(
    "惊不惊喜——刚才跟你聊天的其实是个活人。",
  );
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 阶段3：公网通道状态。没公网地址也能建会话，只是链接只能在自己电脑上点。
  const {
    status,
    busy: statusBusy,
    error: statusError,
    act,
  } = usePublicStatus();

  useEffect(() => {
    getProfile()
      .then(({ profile }) => {
        setOwnerName(profile.ownerName);
        setOwnerAvatarId(profile.ownerAvatarId);
        setOwnerAvatarData(profile.ownerAvatarData ?? "");
        if (profile.defaultRevealMessage)
          setRevealMessage(profile.defaultRevealMessage);
      })
      .catch((err) => {
        // 还没 bootstrap（403）时用表单默认值，不挡创建流程；真正保存发生在点创建之后。
        if (!(err instanceof ApiError && err.status === 403))
          setError("读取本机设置失败，直接用默认值。");
      })
      .finally(() => setLoading(false));
  }, []);

  const handleCreate = async () => {
    setBusy(true);
    setError(null);
    try {
      // 先存身份（揭晓弹窗要用），再建会话：顺序反了会话会快照到旧名字。
      await saveProfile({
        ownerName,
        ownerAvatarId,
        ownerAvatarData,
        defaultRevealMessage: revealMessage,
      });
      // 不送 avatarId：内置四个编号对假 AI 这一侧已经没有意义（服务端按 robot-01 落库，
      // 只作为老数据的兜底留着），展示只看 avatarData + 默认图。
      const created = await createSession({
        aiName,
        avatarData: aiAvatarData || undefined,
        openingMessage,
        revealMessage,
      });
      onCreated(created.session.id);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.status === 403
            ? "还没完成本机验证，请先通过 bootstrap 链接打开控制端。"
            : `创建失败（${err.code}）`
          : "创建失败，请重试。",
      );
    } finally {
      setBusy(false);
    }
  };

  const ready =
    !!ownerName.trim() &&
    !!aiName.trim() &&
    !!openingMessage.trim() &&
    !!revealMessage.trim();

  return (
    <div className="page home-page">
      <header className="topbar">
        <a className="brand" href="/" aria-label="假装 AI 首页">
          <span className="brand-mark" aria-hidden="true">✦</span>
          假装 AI
        </a>
        <PublicStatusPanel
          status={status}
          busy={statusBusy}
          error={statusError}
          act={act}
        />
      </header>

      <section className="home-hero">
        <span className="eyebrow">一场只有你知道的角色扮演</span>
        <h1>把朋友骗进一个<br /><span>“AI” 对话框</span></h1>
        <p>
          你在幕后亲自回复，对方会以为自己正在和 AI 聊天。
          第 10 轮或 20 分钟后揭晓是你。
        </p>
        <div className="hero-doodle" aria-hidden="true">
          <svg viewBox="0 0 180 86" fill="none">
            <path d="M7 57c23-51 46 28 77-15 25-35 35 41 87-25" />
            <path d="m145 8 7 8 10-4M24 13l2 12M16 21l-9 2" />
          </svg>
        </div>
      </section>

      <main className="setup-layout">
        <aside className="setup-guide">
          <span className="eyebrow">开场准备</span>
          <h2>三步搭好这场戏</h2>
          <ol>
            <li><b>1</b><span>留下你的真身份<small>只在揭晓时出现</small></span></li>
            <li><b>2</b><span>捏一个 AI 人设<small>名字、头像与开场白</small></span></li>
            <li><b>3</b><span>写好最后的彩蛋<small>让揭晓不至于冷场</small></span></li>
          </ol>
        </aside>

        <div className="setup-form">
      <section className="form-section card-identity">
        <h2><span>01</span> 揭晓时的你</h2>
        <label>
          称呼
          <input
            value={ownerName}
            onChange={(e) => setOwnerName(e.target.value)}
            placeholder="小李"
            maxLength={40}
          />
        </label>
        <OwnerAvatarPicker
          avatarId={ownerAvatarId}
          avatarData={ownerAvatarData}
          onAvatarId={setOwnerAvatarId}
          onAvatarData={setOwnerAvatarData}
        />
      </section>

      <section className="form-section card-persona">
        <h2><span>02</span> 假 AI 的人设</h2>
        <label>
          AI 名称
          <input
            value={aiName}
            onChange={(e) => setAiName(e.target.value)}
            maxLength={40}
          />
        </label>
        <AvatarPicker
          variant="ai"
          avatarData={aiAvatarData}
          onAvatarData={setAiAvatarData}
        />
        <label className="field-wide">
          开场白
          <textarea
            className="draft-input"
            value={openingMessage}
            onChange={(e) => setOpeningMessage(e.target.value)}
            maxLength={500}
          />
        </label>
      </section>

      <AssistPanel />

      <section className="form-section card-reveal">
        <h2><span>03</span> 最后的彩蛋</h2>
        <label className="field-wide">
          <textarea
            value={revealMessage}
            onChange={(e) => setRevealMessage(e.target.value)}
            maxLength={300}
          />
        </label>
      </section>

      {/* 上一版这个按钮被 flex 拉成 640×41 的绿横条（量尺量出来的）：
          主按钮是一个动作，不是一个区，因些包一排，让它按文字宽度站住。 */}
      <div className="create-bar">
        <button className="primary" onClick={handleCreate} disabled={busy || loading || !ready}>
          {busy ? "正在搭建…" : "创建对话链接 →"}
        </button>
        {!ready && !loading && (
          <p className="hint">称呼、AI 名称、开场白和揭晓留言都不能为空。</p>
        )}
        {error && <p className="error">{error}</p>}
      </div>
        </div>
      </main>
    </div>
  );
}


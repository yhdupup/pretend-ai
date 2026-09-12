import { useEffect, useRef, useState } from "react";
import {
  AVATAR_IDS,
  AVATAR_LABELS,
  avatarEmoji,
} from "../../../../src/shared/avatars";
import { AI_AVATAR_IMG } from "../ai-avatar";
import {
  AVATAR_ACCEPT,
  AI_AVATAR_EDGE,
  OWNER_AVATAR_EDGE,
  imageFromClipboard,
  isSupportedImage,
  isTextEntryTarget,
  readAvatarImage,
} from "../avatar-image";

interface Props {
  /** 哪一张头像：A 的真身（只在揭晓后露脸）还是假 AI（第一秒就给所有人看）。 */
  variant: AvatarVariant;
  /** 内置头像编号：只在 owner 那一侧还有意义（没上传图时的兜底）。 */
  avatarId?: string;
  /** 上传的图（data URL）；空串 = 用兜底（owner 用内置编号，AI 用打包进去的默认图）。 */
  avatarData: string;
  onAvatarId?: (next: string) => void;
  onAvatarData: (next: string) => void;
}

type AvatarVariant = "owner" | "ai";

// 两个头像的差别全在这张表里：措辞（谁能看见这张图，是产品约束，不是文案口味）、
// 压缩边长、没上传时兜底显示什么。逻辑只有一份：点选 / ⌘V / 拖拽三条进法。
const COPY: Record<
  AvatarVariant,
  {
    label: string;
    uploadLabel: string;
    resetLabel: string;
    aria: string;
    alt: string;
    edge: number;
    noteOk: string;
    hint: string;
    /** 兜底显示：内置 emoji 还是打包进去的那张图。 */
    fallbackImage?: string;
    builtInSelect: boolean;
  }
> = {
  owner: {
    label: "头像",
    uploadLabel: "上传自己的照片",
    resetLabel: "用回内置头像",
    aria: "设置你的身份头像",
    alt: "你上传的头像",
    edge: OWNER_AVATAR_EDGE,
    noteOk: "好了。这张图只会在你揭晓之后、给这一位对方看到。",
    hint:
      "三种进法都行：点上面的按钮选文件、选好图直接 ⌘V 粘贴、或者把图拖进这个圈。" +
      `图会在本机压到 ${OWNER_AVATAR_EDGE}×${OWNER_AVATAR_EDGE}，只走这一条链接，不上传到任何地方。`,
    builtInSelect: true,
  },
  ai: {
    label: "AI 头像",
    uploadLabel: "上传头像",
    resetLabel: "用回默认头像",
    aria: "设置假 AI 的头像",
    alt: "你上传的 AI 头像",
    edge: AI_AVATAR_EDGE,
    noteOk:
      "好了。这张图跟名字、开场白一起，从第一秒起给所有拿到这条链接的人看到——别放你本人、也别放你朋友的脸。",
    hint:
      `默认是内置那张机器人图。换图三种进法：点上面的圈选文件、选好图 ⌘V 粘贴、把图拖进来。` +
      `本机压到 ${AI_AVATAR_EDGE}×${AI_AVATAR_EDGE} 后随会话存在这台电脑上，不上传到任何地方。` +
      "（它跟着会话内容走，不像默认图那样能命中浏览器缓存，所以压得比身份头像更小。）",
    fallbackImage: AI_AVATAR_IMG,
    builtInSelect: false,
  },
};

// ── ⌘V 只有一个落点：页面上挂着两个选择器时，谁最后被碰到就归谁 ────────────────────
//
// 粘贴监听只能挂在 document 上才有「选好图 ⌘V 就行」的手感（挂在容器上拿不到焦点），
// 但两个选择器都挂全局监听的话，一张图会同时变成 A 的脸和 AI 的脸。
// 所以：注册表 + 「最后被碰到」的仲裁。页面上只有一个时不仲裁（保持原来的手感）。
type Slot = { accept: (file: File) => void };
const slots = new Map<symbol, Slot>();
let armed: symbol | null = null;

function pasteTarget(): Slot | undefined {
  if (slots.size === 0) return undefined;
  if (slots.size === 1) return slots.values().next().value;
  if (armed && slots.has(armed)) return slots.get(armed);
  // 谁都没被碰过：给第一个挂载的，也就是第 01 段「揭晓时的你」——和只有一个选择器时的老行为一致。
  return slots.values().next().value;
}

/**
 * A 端头像选择器（身份 / 假 AI 共用一套）。
 *
 * 只影响图上这一张：owner 那张在揭晓弹窗里露脸（PRD §7.5），
 * ai 那张从预览起就是 B 看到的"AI 的脸"（PRD §7.1 §17.2）。
 * 上传的图一律先在本机压成正方形小图再传，服务端还有一道形状闸（shared/avatars.sanitizeAvatarData），
 * 不合格就当没传过 —— 宁可退回兜底，也不把任意字符串存进库再发给对方浏览器。
 */
export default function AvatarPicker({
  variant,
  avatarId,
  avatarData,
  onAvatarId,
  onAvatarData,
}: Props) {
  const copy = COPY[variant];
  const fileRef = useRef<HTMLInputElement>(null);
  const me = useRef<symbol>(Symbol("avatar-slot"));
  const [note, setNote] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);

  const take = async (file: File | undefined | null) => {
    if (!file) return false;
    // 类型先在这里挡一道，给用户看得懂的话；服务端 sanitize 是第二道闸（不合法就静默退回兜底）。
    if (!isSupportedImage(file)) {
      setNote("只支持 png / jpg / webp，换一张试试。");
      return true;
    }
    const result = await readAvatarImage(file, copy.edge);
    if (result.ok) {
      onAvatarData(result.data);
      setNote(copy.noteOk);
    } else {
      setNote(result.message);
    }
    return true;
  };

  // 挂载即注册，卸载即注销：路由换了页面之后不能留下一个吃粘贴的幽灵。
  useEffect(() => {
    const key = me.current;
    slots.set(key, { accept: (file) => void take(file) });
    return () => {
      slots.delete(key);
      if (armed === key) armed = null;
    };
    // take 只用到 setter 与 onAvatarData（父层 setState），不需要跟着重挂
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onAvatarData]);

  // 全局听就要会礼貌：焦点在输入框 / 文本域 / contenteditable 里时，这次粘贴属于那个控件，直接放过。
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (isTextEntryTarget(e.target)) return;
      const file = imageFromClipboard(e.clipboardData);
      if (!file) return; // 剪贴板里没图：不吭声，也别拦别人干活
      const slot = pasteTarget();
      if (!slot) return;
      e.preventDefault();
      slot.accept(file);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

  const arm = () => {
    armed = me.current;
  };

  const preview = avatarData || copy.fallbackImage;

  return (
    <div
      className="avatar-field"
      onPointerEnter={arm}
      onFocusCapture={arm}
      onDragOver={(e) => {
        e.preventDefault();
        arm();
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDropping(false);
        void take(e.dataTransfer?.files?.[0]);
      }}
    >
      <span className="avatar-label">{copy.label}</span>
      <div className="avatar-row">
        {/* 预览本身可聚焦、可回车：既能点开文件选择，也给了键盘用户一个落点 */}
        <button
          type="button"
          className={dropping ? "avatar-preview dropping" : "avatar-preview"}
          onClick={() => fileRef.current?.click()}
          title="点击选一张图，或选好图后按 ⌘V 粘贴"
          aria-label={copy.aria}
        >
          {preview ? (
            <img src={preview} alt={copy.alt} width={48} height={48} />
          ) : (
            <span className="avatar-emoji">{avatarEmoji(avatarId ?? "")}</span>
          )}
        </button>
        <div className="avatar-buttons">
          <button
            type="button"
            onClick={() => {
              arm();
              fileRef.current?.click();
            }}
          >
            {copy.uploadLabel}
          </button>
          {avatarData && (
            <button
              type="button"
              className="ghost"
              onClick={() => {
                onAvatarData("");
                setNote(null);
              }}
            >
              {copy.resetLabel}
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept={AVATAR_ACCEPT}
            hidden
            onChange={(e) => {
              void take(e.target.files?.[0]);
              // 清空 value：同一张图连选两次也要能重新触发（否则 onChange 不再 fire）。
              e.target.value = "";
            }}
          />
        </div>
      </div>
      {/* 说明整幅走在下面：以前它挤在按钮块里，把右侧顶到 106px 高，旁边只有 56px 的圆片，整行对不齐 */}
      <span className="hint">{copy.hint}</span>
      {/* 换图失败/过大的反馈仍要在正下方说（上一版排版时一度把这句弄丢了） */}
      {note && <p className="field-note">{note}</p>}
      {copy.builtInSelect && onAvatarId && (
        <label>
          没上传时的内置头像
          <select
            value={avatarId}
            onChange={(e) => onAvatarId(e.target.value)}
            disabled={!!avatarData}
          >
            {AVATAR_IDS.map((id) => (
              <option key={id} value={id}>
                {avatarEmoji(id)} {AVATAR_LABELS[id]}
              </option>
            ))}
          </select>
        </label>
      )}
      {variant === "ai" && (
        <span className="hint">
          鼠标先经过哪个头像圈，⌘V 贴进来的图就进哪一个。
        </span>
      )}
    </div>
  );
}

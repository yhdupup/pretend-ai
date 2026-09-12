// 内置头像清单：A 前端下拉、B 前端展示、服务端设置校验三方共用同一份。
// 放在 shared 而不是 server/settings 里，是因为前端不能 import 服务端模块
// （那会把 better-sqlite3 拖进浏览器包）。
// 2026-09-12 起 A 的身份头像可以上传自己的图（见下面 avatarData 那一组）；
// 2026-09-13 起假 AI 的头像也改成「一张默认图 + 可自己上传/粘贴替换」，创建窗口里那个
// 四选一下拉已经删掉（PRD §7.1 改了口径）。两者共用下面同一组闸（形状、字符上限、
// 不合法退回默认），差别只在**可见范围**：身份头像只在揭晓后给那一位对方看，
// AI 头像从一开始就给所有拿到链接的人看。

export const AVATAR_IDS = [
  "robot-01",
  "robot-02",
  "robot-03",
  "robot-04",
] as const;
export type AvatarId = (typeof AVATAR_IDS)[number];

export const AVATAR_LABELS: Record<AvatarId, string> = {
  "robot-01": "圆脸机器人",
  "robot-02": "方脸机器人",
  "robot-03": "眨眼星人",
  "robot-04": "墨镜侠",
};

export const DEFAULT_AVATAR_ID: AvatarId = "robot-01";

export function isAvatarId(value: string): value is AvatarId {
  return (AVATAR_IDS as readonly string[]).includes(value);
}

/**
 * 假 AI 的默认头像文件名。两个前端各存一份**同样字节**的这个文件
 * （apps/a-frontend/src/assets/ 与 apps/b-frontend/src/assets/，test/owner-avatar.test.ts 里
 * 有一条用例钉住「两边都在、字节一致」）。
 *
 * 为什么是文件名而不是 URL：真正的 URL 由打包器算出来（/assets/ai-avatar-<hash>.jpg），
 * 各前端自己 import。**不能**图省事丢进 public/ 走根路径 —— B 那个进程只认 /assets/*
 * 和 /s/:id 两条路径（src/server/static/b-site.ts 顶部的安全边界），根路径下的图片会被白名单
 * 404 掉。走 assets 既守住边界，又白拿「文件名带哈希 = 换图自动失效」的一年 immutable 缓存。
 *
 * 为什么是文件而不是 data URL：默认头像每次冷访问都要下发，走文件能命中缓存（第二次零字节）；
 * 上传替换的那张要落在会话行里，只能内联 data URL，两条路各管各的（见 sanitizeAvatarData）。
 */
export const DEFAULT_AI_AVATAR_FILE = "ai-avatar.jpg";

// 没有真实图片资源，先用文字头像占位（阶段5 换设计稿时改这一个函数）。
export function avatarEmoji(avatarId: string): string {
  switch (avatarId) {
    case "robot-02":
      return "🤖";
    case "robot-03":
      return "👾";
    case "robot-04":
      return "😎";
    default:
      return "🟢";
  }
}

// ── 自定义身份头像（只给 A 的真身用，揭晓时随 RevealInfo 发给 B）────────────────
//
// 为什么走 data URL 而不是存文件：存盘就要给 B 端开一条新的公开路由去取图，
// 那条路由无法要求登录、还会多一个「这个链接是不是这个人的」的可分辨面。
// 随已有的揭晓载荷一起走 base64，公开面一个字节都没多。
// 前端负责先压到 256×256 再传，这里只把住最外层的闸。

/** data URL 字符串上限。256×256 的 PNG 一般 30~80KB，base64 后 ×1.33；留足余量。 */
export const MAX_AVATAR_DATA_CHARS = 400_000;

/** 只收三种位图，且必须是纯 base64（不接受 SVG：里面能塞脚本）。 */
const AVATAR_DATA_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

/** 不合法就当没传过（回空串）：宁可用回内置头像，也不把任意字符串存进库再发给 B。 */
export function sanitizeAvatarData(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (!text) return "";
  if (text.length > MAX_AVATAR_DATA_CHARS) return "";
  return AVATAR_DATA_RE.test(text) ? text : "";
}

/** 有自定义图就用 <img>，没有就用内置文字头像。 */
export function hasAvatarData(value: string | null | undefined): boolean {
  return !!value && value.trim() !== "";
}

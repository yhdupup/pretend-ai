// A 上传头像时的本地压图：读文件 → 居中裁成正方形 → 缩到指定边长 → 出 data URL。
// 两张头像共用这一条管线，只是边长不同（见下面两个常量）。
//
// 为什么在浏览器里压完再传，而不是把原图丢给服务端：
// 这工具没有图片处理依赖（也没有 sharp），而且原图动辄几 MB，本机 SQLite 里
// 存一堆原图字节毫无意义——揭晓卡片上那张脸只有 44px。压完再传，服务端只需要
// 校验形状（shared/avatars.sanitizeAvatarData），公开载荷也不会被撑肥。
import { MAX_AVATAR_DATA_CHARS } from "../../../src/shared/avatars";

/** 身份头像输出边长：揭晓卡片上最大显示 64px，Retina 两倍够。 */
export const OWNER_AVATAR_EDGE = 256;
/**
 * 假 AI 头像输出边长。比身份头像小一档是有原因的：
 * 身份头像只在揭晓那一次随载荷走，而 AI 头像挂在会话/预览载荷里，
 * 每次打开这条链接都要重下一遍（data URL 内联在 JSON 里，命中不了浏览器缓存）。
 * 显示位置只有 42px，160 已经留了两倍多的余量。
 */
export const AI_AVATAR_EDGE = 160;
/** 原图字节上限：超过就让用户自己先压，不替他跑一次几十 MB 的解码。 */
const MAX_INPUT_BYTES = 8 * 1024 * 1024;

export type AvatarRead =
  | { ok: true; data: string }
  | { ok: false; message: string };

export const AVATAR_ACCEPT = "image/png,image/jpeg,image/webp";

/** 只认三种位图：SVG 能嵌脚本，GIF 可能是动图，都不收。 */
export function isSupportedImage(file: Blob): boolean {
  return (
    file.type === "image/png" ||
    file.type === "image/jpeg" ||
    file.type === "image/webp"
  );
}

export async function readAvatarImage(
  file: Blob,
  edge: number = OWNER_AVATAR_EDGE,
): Promise<AvatarRead> {
  if (!isSupportedImage(file))
    return { ok: false, message: "只支持 png / jpg / webp，换一张试试。" };
  if (file.size > MAX_INPUT_BYTES)
    return { ok: false, message: "这张图超过 8MB，先压小一点再传。" };

  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const png = encodeSquare(img, edge, "image/png");
    if (fits(png)) return { ok: true, data: png };
    // PNG 太大（照片转 PNG 会膨胀）：退回 JPEG，牺牲透明换体积。
    const jpeg = encodeSquare(img, Math.round(edge * 0.625), "image/jpeg", 0.85);
    if (fits(jpeg)) return { ok: true, data: jpeg };
    return { ok: false, message: "这张图压完还是太大，换一张小一点的。" };
  } catch {
    return { ok: false, message: "读不出这张图，可能已经损坏或不是图片。" };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function fits(data: string): boolean {
  return data.length > 0 && data.length <= MAX_AVATAR_DATA_CHARS;
}

function encodeSquare(
  img: HTMLImageElement,
  edge: number,
  type: string,
  quality?: number,
): string {
  const canvas = document.createElement("canvas");
  canvas.width = edge;
  canvas.height = edge;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas 2d context");
  // 居中裁一个正方形再铺满画布：不拉伸变形，也不留黑边。
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  const sx = (img.naturalWidth - side) / 2;
  const sy = (img.naturalHeight - side) / 2;
  ctx.drawImage(img, sx, sy, side, side, 0, 0, edge, edge);
  return canvas.toDataURL(type, quality);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image load failed"));
    img.src = src;
  });
}

/**
 * 从剪贴板里挑出一张图。
 *
 * `clipboardData.files` 在 Chrome / Safari 上对「从 Finder 复制的图片文件」有货，
 * 但对「从微信 / 网页里复制的一张图」常常是空的，图只在 `items` 里（kind=file）。
 * 两条都试，才有「选好图 ⌘V 就行」这种手感。
 */
export function imageFromClipboard(data: DataTransfer | null): File | null {
  if (!data) return null;
  const direct = data.files?.[0];
  if (direct) return direct;
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  return null;
}

/** 粘贴目标是不是一个正在输入文字的控件：是的话这次粘贴属于那个控件，别抢。 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return el.isContentEditable === true;
}

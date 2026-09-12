// 假 AI 的默认头像：走打包器，不走 public/（原因见 src/shared/avatars.ts 里那段注释 ——
// B 那个进程的静态白名单只认 /assets/*，根路径的图片会被 404）。
import aiAvatarUrl from "./assets/ai-avatar.jpg";

/** B 端头部与 A 端预览圈在「A 没上传图」时画的那张脸。 */
export const AI_AVATAR_IMG = aiAvatarUrl;

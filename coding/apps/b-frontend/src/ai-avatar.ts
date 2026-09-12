// 假 AI 的默认头像。跟 A 端那份是同一个字节内容（有一条测试钉着），
// 但 URL 各自带哈希，所以两个前端各自 import 自己那一份。
import aiAvatarUrl from "./assets/ai-avatar.jpg";

/** A 没上传头像时，B 顶上画的那张默认图。 */
export const AI_AVATAR_IMG = aiAvatarUrl;

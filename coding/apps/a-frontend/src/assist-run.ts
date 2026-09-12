// 会话页两个按钮（处置正文 / 深度反推）的行为约束，抽成纯函数好钉住。
//
// 来由（2026-09-12 用户报告「B 那边看不到深度思考的过程」）：
// 服务端每次 /process 都是**从零生成一份完整处置**，前端拿到响应会整体替换当前 process。
// 于是「先点深度反推、再点处置正文」这个最自然的顺序，会让后一次调用（analysisEnabled=false）
// 把刚生成的那份过程从 process 里顶掉，而输入框里的文字还留着 ——
// 界面看起来有过程，发出去的 processId 里却是空的，B 自然什么都收不到。
//
// 修法不用「让按钮替 A 把过程带着提交」（那等于自动确认，绕过 §6.6），
// 而是把「框里有一段过程、但它没跟当前这次处置绑定」如实判成待确认，
// 让 §6.6 原有的闸口亮起来：要么重新反推，要么 A 亲手点「确认这条摘要」。
import type { ProcessRequest } from "../../../src/shared/types";

export type AssistKind = "polish" | "analysis";

/**
 * 一次按钮点击要提交的载荷。各点各的字段，谁也不顺手改对方那一栏。
 * 深度反推时 aiStyleEnabled=false，服务端返回的 reply 就是传进去的正文原文（不重写）。
 */
export function assistRunPayload(
  kind: AssistKind,
  draft: string,
  styleLevel: ProcessRequest["styleLevel"],
): ProcessRequest {
  return kind === "analysis"
    ? { draft, aiStyleEnabled: false, analysisEnabled: true, styleLevel }
    : { draft, aiStyleEnabled: true, analysisEnabled: false, styleLevel };
}

/** 这条过程文本是否已经跟当前处置绑定（= 服务端这份 process 里存的就是它）。 */
export function analysisBound(
  analysis: string,
  process: { analysisSummary: string } | null,
): boolean {
  const text = (analysis ?? "").trim();
  if (!text) return true; // 框是空的：没有过程要绑定，纯发正文不算不一致
  return !!process && (process.analysisSummary ?? "").trim() === text;
}

/** §6.6 闸门的真实条件：框里有字且没绑定 —— 不许直接发。 */
export function analysisStale(opts: {
  analysis: string;
  process: { analysisSummary: string } | null;
}): boolean {
  return (opts.analysis ?? "").trim() !== "" && !analysisBound(opts.analysis, opts.process);
}

/** 「展示给对方的分析过程」那个框该不该露出来。 */
export function shouldShowAnalysisBox(opts: {
  analysisEnabled: boolean;
  analysis: string;
  hasPending: boolean;
}): boolean {
  // 只看全局开关不够：开关关着但框里已经躺着一段会被发出去的过程时，
  // 藏起来就等于让 A 对着一个看不见的东西。
  return opts.hasPending && (opts.analysisEnabled || (opts.analysis ?? "").trim() !== "");
}

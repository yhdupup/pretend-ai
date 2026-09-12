// 复现「连接测试成功、真实处理失败」：用思考型模型 + 真实 Skill 全文跑一遍 runAssist。
// 只打印结构与失败码，不打印密钥、不打印模型正文。
import { readFileSync, existsSync } from "node:fs";
import { parse as parseEnv } from "dotenv";
import { setCredentials } from "./src/model/credentials.js";
import { getSkillRegistry } from "./src/assist/skills/loader.js";
import { chatCompletion, ModelCallError } from "./src/model/adapter.js";
import { runAssist } from "./src/assist/orchestrator.js";

const ROOT = "/Users/a1234/Desktop/个人项目/假装ai";
const env: Record<string, string> = {};
for (const f of [`${ROOT}/.env.example`, `${ROOT}/.env.local`]) {
  if (!existsSync(f)) continue;
  for (const [k, v] of Object.entries(parseEnv(readFileSync(f, "utf8"))))
    if (v?.trim()) env[k] = v.trim();
}

const modelId = process.argv[2] ?? "step-3.7-flash";
setCredentials({
  baseUrl: env.USER_MODEL_BASE_URL,
  modelId,
  apiKey: env.USER_MODEL_API_KEY,
});
console.log("探测模型:", modelId, "| MODEL_MAX_TOKENS:", env.MODEL_MAX_TOKENS ?? "900(默认)");

const registry = getSkillRegistry();
const draft =
  "在的在的，我这边网络有点抽，刚才会话掉了一次。你说的那个我看了，方向没问题，细节我再核一下，晚点给你结论。";

// 1) 裸调用：看 HTTP 层到底给了什么
for (const [label, skill] of [
  ["rewrite", registry.aiStyle],
  ["analysis", registry.analysis],
] as const) {
  const sys = [
    "你是一个文本处理执行器。下面给出本次任务必须遵守的 Skill 指令全文。",
    `# 生效 Skill：${skill.skillId} v${skill.skillVersion}\n\n${skill.instruction}`,
    "输出：只输出一个 JSON 对象，不要代码围栏。",
  ].join("\n\n");
  try {
    const r = await chatCompletion(sys, JSON.stringify({ mode: label, draft, pendingQuestion: "在的？", recentMessages: [], skills: [], constraints: { preserveFacts: true, maxReplyChars: 500, maxAnalysisChars: 300, styleLevel: "明显" } }));
    console.log(`[${label}] 拿到文本 ${r.text.length} 字，前 40 字:`, r.text.slice(0, 40).replace(/\s+/g, " "));
  } catch (err) {
    console.log(
      `[${label}] 调用失败:`,
      err instanceof ModelCallError ? `kind=${err.kind} retryable=${err.retryable} msg=${err.message}` : String(err),
    );
  }
}

// 2) 完整编排：A 实际看到的失败码
for (const [label, flags] of [
  ["增加 AI 味", { aiStyleEnabled: true, analysisEnabled: false }],
  ["深度反推", { aiStyleEnabled: false, analysisEnabled: true }],
] as const) {
  const out = await runAssist({
    draft,
    question: "在的？",
    recent: [],
    ...flags,
    styleLevel: "明显",
    mode: "user_model",
    skillRegistry: registry,
  });
  console.log(
    `【${label}】`,
    out.ok
      ? `成功 calls=${out.result.calls} 正文${out.result.reply.length}字 摘要${out.result.analysisSummary.length}字 warnings=${JSON.stringify(out.result.warnings)}`
      : `失败 ${out.failure.code}：${out.failure.reason}`,
  );
}

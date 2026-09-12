// 一次性诊断脚本：复现「连接测试成功、真实调用 BAD_RESPONSE」。
// 只打印结构信息（状态码 / finish_reason / 字段类型 / 长度），绝不打印密钥与正文。
import { readFileSync, existsSync } from "node:fs";
import { parse } from "dotenv";

const ROOT = "/Users/a1234/Desktop/个人项目/假装ai";
const env = {};
for (const f of [`${ROOT}/.env.example`, `${ROOT}/.env.local`]) {
  if (!existsSync(f)) continue;
  for (const [k, v] of Object.entries(parse(readFileSync(f, "utf8")))) {
    if (v && v.trim()) env[k] = v.trim();
  }
}
const base = env.USER_MODEL_BASE_URL;
const model = env.USER_MODEL_ID;
const key = env.USER_MODEL_API_KEY;
console.log("base:", base, "| model:", model, "| key len:", key?.length ?? 0);

const body = {
  model,
  messages: [
    { role: "system", content: "你是文本处理执行器。" },
    {
      role: "user",
      content: JSON.stringify({
        mode: "rewrite",
        draft: "在的，我这边网络有点卡，稍等我两分钟再回你哈。",
        pendingQuestion: "你还在吗？",
        recentMessages: [],
        skills: [],
        constraints: {
          preserveFacts: true,
          maxReplyChars: 500,
          maxAnalysisChars: 300,
          styleLevel: "明显",
        },
      }),
    },
  ],
  temperature: Number(env.MODEL_TEMPERATURE ?? 0.4),
  max_tokens: Number(env.MODEL_MAX_TOKENS ?? 900),
  stream: false,
};

const shape = (payload) => {
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
  const msg = choice?.message ?? null;
  return {
    topKeys: Object.keys(payload ?? {}).slice(0, 12),
    choiceKeys: choice ? Object.keys(choice) : null,
    messageKeys: msg ? Object.keys(msg) : null,
    messageType: msg
      ? Object.fromEntries(
          Object.entries(msg).map(([k, v]) => [
            k,
            v === null
              ? "null"
              : Array.isArray(v)
                ? `array(${v.length})`
                : typeof v,
          ]),
        )
      : null,
    contentLen:
      typeof msg?.content === "string"
        ? msg.content.length
        : Array.isArray(msg?.content)
          ? JSON.stringify(msg.content).length
          : null,
    reasoningLen:
      typeof msg?.reasoning_content === "string"
        ? msg.reasoning_content.length
        : null,
    finishReason: choice?.finish_reason ?? null,
    usage: payload?.usage ?? null,
    error: payload?.error ?? payload?.message ?? payload?.code ?? null,
  };
};

async function call(label, patch, transform) {
  const url = new URL("chat/completions", base.endsWith("/") ? base : `${base}/`);
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(
        transform ? transform({ ...body, ...patch }) : { ...body, ...patch },
      ),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    console.log(`\n[${label}] FETCH ERROR`, err?.name, String(err?.message).slice(0, 120));
    return;
  }
  const text = await res.text();
  console.log(`\n[${label}] HTTP ${res.status} ${Date.now() - t0}ms ct=${res.headers.get("content-type")}`);
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    console.log("  NOT JSON. head:", text.slice(0, 200).replace(/\s+/g, " "));
    return;
  }
  console.log("  shape:", JSON.stringify(shape(payload)));
}

await call("A 探针（等价连接测试：小 prompt）", {
  messages: [
    { role: "system", content: "你是连通性探针。" },
    { role: "user", content: "只回复一个字：好" },
  ],
});
await call("B 真实改写请求（当前参数）", {});
await call("C 真实改写 + max_tokens=4000", { max_tokens: 4000 });
await call("D 真实改写 + 不带 temperature", {}, ({ temperature, ...rest }) => rest);
await call("E 真实改写 + 不带 max_tokens", {}, ({ max_tokens, ...rest }) => rest);

// 「上游没给出能读的结果」到底是哪种：拿几种常见填法的真实回包形状验证。
// 只打印 HTTP 状态、content-type、以及顶层字段名（不打正文、不打密钥）。
import { readFileSync, existsSync } from "node:fs";
import { parse as parseEnv } from "dotenv";

const ROOT = "/Users/a1234/Desktop/个人项目/假装ai";
const env: Record<string, string> = {};
for (const f of [`${ROOT}/.env.example`, `${ROOT}/.env.local`]) {
  if (!existsSync(f)) continue;
  for (const [k, v] of Object.entries(parseEnv(readFileSync(f, "utf8"))))
    if (v?.trim()) env[k] = v.trim();
}
const key = env.USER_MODEL_API_KEY;
const good = env.USER_MODEL_BASE_URL.replace(/\/+$/, "");
const model = "step-1o-turbo-vision";

const candidates = [
  good, // 正确写法
  `${good}/chat/completions`, // 常见误填：把完整接口路径当地址
  good.replace(/\/v1$/, ""), // 常见误填：漏掉 /v1
  good.replace(/\/v1$/, "/step_plan/v1"), // 另一个入口，可用模型不同
  `${good.replace(/^https:\/\//, "https://")}/v1beta`, // 猜错风格
];

for (const base of candidates) {
  let url;
  try {
    // 完全照 src/model/adapter.ts 的拼法：new URL("chat/completions", base + "/")
    url = new URL("chat/completions", base.endsWith("/") ? base : `${base}/`).toString();
  } catch (e) {
    console.log(`\n地址 ${base}\n  → URL 拼不出来：${(e as Error).message}`);
    continue;
  }
  console.log(`\n填 "${base}"\n  实际打 ${url}`);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "你是连通性探针。" },
          { role: "user", content: "只回复一个字：好" },
        ],
        temperature: 0.4,
        max_tokens: 900,
        stream: false,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const text = await r.text();
    const head = text.slice(0, 120).replace(/\s+/g, " ");
    const isJson = head.trim().startsWith("{") || head.trim().startsWith("[");
    let keys = "";
    if (isJson) {
      try {
        const p = JSON.parse(text);
        keys = `顶层键=[${Object.keys(p).join(",")}]`;
        const c0 = p?.choices?.[0];
        if (c0)
          keys += ` choices[0]=[${Object.keys(c0).join(",")}] content类型=${typeof c0?.message?.content} finish=${c0.finish_reason ?? "?"}`;
        if (p?.error) keys += ` error.code=${p.error.code ?? "-"} error.type=${p.error.type ?? "-"}`;
      } catch {
        keys = "JSON 解析失败";
      }
    }
    console.log(
      `  → HTTP ${r.status} content-type=${r.headers.get("content-type") ?? "-"} 长度=${text.length}`,
    );
    console.log(`  → ${keys || `不是 JSON，开头: ${head}`}`);
  } catch (err) {
    console.log(`  → 请求抛错: ${(err as Error).name} ${(err as Error).message}`);
  }
}

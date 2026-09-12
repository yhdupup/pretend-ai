// 临时：拿真代码（dist 同源逻辑）看「你填的地址」被拼成「实际请求的地址」。不发任何网络请求，fetch 是桩。
import { chatCompletion } from "../src/model/adapter.js";
import { setCredentials, clearCredentials } from "../src/model/credentials.js";

const cases = [
  "https://api.openai-next.com",
  "https://api.openai-next.com/",
  "https://api.openai-next.com/v1",
  "https://api.openai-next.com/v1/",
  "https://api.openai-next.com/v1/chat/completions",
  "https://api.openai-next.com/v1?api-version=2024-02-01",
  "https://api.openai-next.com/openai/v1",
  "https://api.openai-next.com/v1  ",
];

const reply = {
  status: 200,
  headers: { "content-type": "application/json" },
};

for (const base of cases) {
  clearCredentials();
  const seen: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    seen.push(String(input));
    return new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: "好" } }] }),
      reply,
    );
  }) as typeof fetch;
  try {
    await chatCompletion("sys", "user", { baseUrl: base, modelId: "m", apiKey: "k" });
  } catch (err) {
    seen.push("抛错：" + (err as Error).message);
  } finally {
    globalThis.fetch = real;
  }
  console.log(
    `填「${JSON.stringify(base)}」\n  → 打的是 ${seen[0]}\n`,
  );
}
void setCredentials;

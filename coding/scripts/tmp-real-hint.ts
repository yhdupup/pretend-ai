// 临时：拿真供应商主机验一遍新逻辑（**用假密钥**，不碰 .env.local 里那把）。
import { chatCompletion, detectApiPrefix, ModelCallError } from "../src/model/adapter.js";

const base = process.argv[2] ?? "https://api.openai-next.com";
try {
  const r = await chatCompletion("只回一个字", "好", {
    baseUrl: base,
    modelId: "gpt-4o-mini",
    apiKey: "invalid-test-key",
  });
  console.log("居然通了：", r.text.slice(0, 40));
} catch (err) {
  if (!(err instanceof ModelCallError)) throw err;
  console.log(`kind=${err.kind} status=${err.httpStatus} bodyKind=${err.bodyKind}`);
  console.log(`实际请求：${err.endpointUrl}`);
  // 跟路由一致：只有「地址回的是网页/空」这一类才探（401 那种是密钥问题，别多打一发）
  const hint =
    err.kind === "BAD_ENDPOINT" && err.endpointUrl
      ? await detectApiPrefix(err.endpointUrl)
      : null;
  console.log(`不带密钥探到的前缀：${hint ?? "不需要 / 没探到"}`);
}

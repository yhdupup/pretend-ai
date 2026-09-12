import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectApiPrefix,
  ModelCallError,
  chatCompletion,
  resetTokenBudget,
} from "../src/model/adapter.js";
import {
  clearCredentials,
  getCredentials,
  setCredentials,
} from "../src/model/credentials.js";
import { config } from "../src/server/config.js";

/**
 * 上游适配器的形状与自愈（PRD §9.4 §9.5）。
 *
 * 起因是一次真实反馈：设置页「连接测试」成功，但两个按钮全部失败。
 * 根因是带思考字段的模型会把 max_tokens 预算先花在 reasoning_content 上，
 * 正文回来是 null 或半截 JSON；而探针只要一个字，永远撞不到这堵墙。
 * 这里用假 fetch 把三种形状钉住：数组 content、思考吐空、以及吐空后的换预算重试。
 */

interface Sent {
  maxTokens: number;
  url: string;
}

const sent: Sent[] = [];
type Reply = {
  status: number;
  body?: unknown;
  /** 直接给原始响应体：要验「回来的根本不是 JSON」这类形状只能用这个。 */
  raw?: string;
  contentType?: string;
};
let replies: (() => Reply)[] = [];

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: { body?: string }) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        max_tokens?: number;
      };
      sent.push({ maxTokens: Number(payload.max_tokens ?? 0), url: String(url) });
      const next = replies.shift();
      if (!next) throw new Error("测试没准备这么多响应");
      const { status, body, raw, contentType } = next();
      return new Response(raw ?? JSON.stringify(body), {
        status,
        headers: { "content-type": contentType ?? "application/json" },
      });
    }),
  );
}

const okBody = (content: unknown, finishReason = "stop") => ({
  status: 200,
  body: {
    choices: [
      {
        message: {
          role: "assistant",
          content,
          // 推理模型的思考字段：一个字符都不许被当成正文。
          reasoning_content: "先想想 A 到底在问什么……（这一大段不该出现在结果里）",
        },
        finish_reason: finishReason,
      },
    ],
  },
});

beforeEach(() => {
  sent.length = 0;
  replies = [];
  stubFetch();
  resetTokenBudget();
  setCredentials({
    baseUrl: "http://127.0.0.1:5678/v1",
    modelId: "test-model",
    apiKey: "sk-test-key",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearCredentials();
  resetTokenBudget();
});

describe("上游响应形状", () => {
  it("content 是文本块数组时也认（OpenAI 兼容网关的常见形状）", async () => {
    replies = [
      () =>
        okBody([
          { type: "text", text: '{"reply":"在的",' },
          { type: "text", text: '"analysis_summary":"想先确认预算"}' },
        ]),
    ];
    const result = await chatCompletion("sys", "user");
    expect(result.text).toBe('{"reply":"在的","analysis_summary":"想先确认预算"}');
    expect(result.escalated).toBe(false);
  });

  it("只有思考字段、正文为 null → 认成预算问题，不是「格式不认识」", async () => {
    replies = [
      // 第一次：content 被思考挤没了
      () => okBody(null, "length"),
      // 加大预算后拿到了正文
      () => okBody('{"reply":"在的","analysis_summary":"先看预算"}'),
    ];
    const result = await chatCompletion("sys", "user");
    expect(result.text).toContain("在的");
    expect(result.escalated).toBe(true);
    // 第二次请求的预算必须严格大于第一次，否则换值重试是白跑
    expect(sent).toHaveLength(2);
    expect(sent[1].maxTokens).toBeGreaterThan(sent[0].maxTokens);
    expect(sent[0].maxTokens).toBe(config.modelMaxTokens);
  });

  it("正文被截断（JSON 没合上）→ 换大预算重来，不把半截结果交给校验闸", async () => {
    replies = [
      () => okBody('{"reply":"在的，我刚', "length"),
      () => okBody('{"reply":"在的，我刚看到","analysis_summary":"x"}'),
    ];
    const result = await chatCompletion("sys", "user");
    expect(result.escalated).toBe(true);
    expect(result.text.endsWith("}")).toBe(true);
  });

  it("写完的 JSON 即使 finish_reason=length 也不丢：结构闭合就交给闸口判", async () => {
    replies = [() => okBody('{"reply":"在的","analysis_summary":"x"}', "length")];
    const result = await chatCompletion("sys", "user");
    expect(result.text).toContain("在的");
    expect(sent).toHaveLength(1);
  });

  it("换了预算还是空 → 抛 TRUNCATED（不谎报限流）", async () => {
    replies = [
      () => okBody(null, "length"),
      () => okBody("", "length"),
      () => okBody("", "length"),
      () => okBody("", "length"),
    ];
    const err = await chatCompletion("sys", "user").catch((e) => e);
    expect(err).toBeInstanceOf(ModelCallError);
    expect((err as ModelCallError).kind).toBe("TRUNCATED");
    expect(sent.length).toBeGreaterThanOrEqual(2);
    // 自愈只换一次预算，不该越换越小
    expect(new Set(sent.map((s) => s.maxTokens)).size).toBe(2);
  });

  it("思考字段本身永远不会成为返回正文（§8.3 思维链不外传）", async () => {
    replies = [() => okBody("正经答案")];
    const result = await chatCompletion("sys", "user");
    expect(result.text).toBe("正经答案");
    expect(result.text).not.toContain("reasoning");
  });

  it("401 不重试：鉴权错三次也是同一个错", async () => {
    replies = [
      () => ({ status: 401, body: { error: { message: "bad key" } } }),
    ];
    const err = await chatCompletion("sys", "user").catch((e) => e);
    expect(err).toBeInstanceOf(ModelCallError);
    expect((err as ModelCallError).kind).toBe("AUTH");
    expect(sent).toHaveLength(1);
  });

  // ↓ 「连接测试报 UNKNOWN_ERROR / 上游没给出能读的结果」那一类：地址填错的三种形状必须分得开。
  it("地址多带一层 /chat/completions → BAD_ENDPOINT，并回显实际请求路径", async () => {
    setCredentials({ baseUrl: "http://127.0.0.1:5678/v1/chat/completions" });
    replies = [() => ({ status: 404, raw: "" })];
    const err = await chatCompletion("sys", "user").catch((e) => e);
    expect(err).toBeInstanceOf(ModelCallError);
    expect((err as ModelCallError).kind).toBe("BAD_ENDPOINT");
    expect((err as ModelCallError).retryable).toBe(false);
    // 套娃路径要在错误里看得见，否则用户不知道该改哪一项
    expect((err as ModelCallError).endpointPath).toBe(
      "/v1/chat/completions/chat/completions",
    );
    expect(sent).toHaveLength(1);
  });

  it("404 且回的是带 error 的 JSON → 归 BAD_REQUEST（地址对、模型名不对）", async () => {
    replies = [
      () => ({
        status: 404,
        body: { error: { code: "model_invalid", message: "sk-别把这句话外传" } },
      }),
    ];
    const err = await chatCompletion("sys", "user").catch((e) => e);
    expect((err as ModelCallError).kind).toBe("BAD_REQUEST");
    // 只用「是不是带 error 字段的 JSON」这个布尔，原文一个字节都不外传（§18.6）
    expect((err as ModelCallError).message).not.toContain("别把这句话外传");
    expect((err as ModelCallError).httpStatus).toBe(404);
  });

  it("200 但回的是 HTML 页面 → BAD_ENDPOINT，且不浪费三次重试", async () => {
    replies = [
      () => ({
        status: 200,
        raw: "<!doctype html><html><body>登录页</body></html>",
        contentType: "text/html",
      }),
    ];
    const err = await chatCompletion("sys", "user").catch((e) => e);
    expect((err as ModelCallError).kind).toBe("BAD_ENDPOINT");
    expect(sent).toHaveLength(1);
  });

  it("200 且是 JSON 但没有正文 → BAD_RESPONSE，并回显顶层字段名（只给字段名）", async () => {
    // 这一类是可重试形状，关掉重试次数，免得测试真的等 1s+2s 退避
    const saved = config.modelRetryTimes;
    config.modelRetryTimes = 0;
    replies = [
      () => ({ status: 200, body: { result: { output: "sk-也不外传这句" } } }),
    ];
    const err = await chatCompletion("sys", "user").catch((e) => e);
    config.modelRetryTimes = saved;
    expect((err as ModelCallError).kind).toBe("BAD_RESPONSE");
    expect((err as ModelCallError).message).toContain("result");
    expect((err as ModelCallError).message).not.toContain("也不外传");
  });

  // 不记这一笔的话，推理模型每一次点按钮都要先花一次注定为空的调用（实测 ≈ 7 秒）。
  it("换预算成功后记住这一档：下一次不再先跑一次空正文", async () => {
    replies = [
      () => okBody(null, "length"),
      () => okBody('{"reply":"第一次"}'),
      () => okBody('{"reply":"第二次"}'),
    ];
    const first = await chatCompletion("sys", "user");
    expect(first.escalated).toBe(true);
    expect(sent.map((s) => s.maxTokens)).toEqual([
      config.modelMaxTokens,
      config.modelMaxTokensEscalate,
    ]);
    sent.length = 0;
    const second = await chatCompletion("sys", "user");
    expect(second.text).toContain("第二次");
    expect(sent).toHaveLength(1);
    expect(sent[0].maxTokens).toBe(config.modelMaxTokensEscalate);
  });

  it("凭证变了 → 学到的预算跟着清掉", async () => {
    replies = [
      () => okBody(null, "length"),
      () => okBody('{"reply":"好"}'),
      () => okBody('{"reply":"换了模型之后"}'),
    ];
    await chatCompletion("sys", "user");
    resetTokenBudget();
    sent.length = 0;
    await chatCompletion("sys", "user");
    expect(sent[0].maxTokens).toBe(config.modelMaxTokens);
  });
});

describe("草稿凭证（连通性测试测的就是界面上这三项）", () => {
  it("带草稿调用：打的是草稿地址、用的模型名是草稿的，内存里那套不被改写", async () => {
    replies = [
      () => okBody('{"reply":"草稿那套"}'),
      () => okBody('{"reply":"保存那套"}'),
    ];
    const draft = await chatCompletion("sys", "user", {
      baseUrl: "http://127.0.0.1:5678/beta/",
      modelId: "draft-model",
    });
    expect(draft.text).toContain("草稿");
    expect(sent[0].url).toBe("http://127.0.0.1:5678/beta/chat/completions");
    // 回给界面的「这次打的是哪个地址」：草稿尾部的斜杠按 §9.4 规范化掉
    expect(draft.endpointUrl).toBe("http://127.0.0.1:5678/beta/chat/completions");

    // 草稿一个字都不进内存：紧接着不传草稿，打的仍是 beforeEach 里保存的那套
    const saved = await chatCompletion("sys", "user");
    expect(saved.text).toContain("保存");
    expect(sent[1].url).toBe("http://127.0.0.1:5678/v1/chat/completions");
    expect(getCredentials()?.modelId).toBe("test-model");
  });

  it("草稿缺模型名 → NOT_CONFIGURED 并点名缺哪一项，一个请求都不发", async () => {
    replies = [() => okBody('{"reply":"不该被调用"}')];
    const err = await chatCompletion("sys", "user", {
      baseUrl: "http://127.0.0.1:5678/beta",
      modelId: "   ",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ModelCallError);
    expect((err as ModelCallError).kind).toBe("NOT_CONFIGURED");
    expect((err as ModelCallError).message).toContain("模型名");
    expect(sent).toHaveLength(0);
  });
});

describe("地址拼接与「前缀在哪」探测", () => {
  it("服务地址带查询参数时不丢路径层（实跑测到 /v1 被静悄悄吃掉）", async () => {
    replies = [() => okBody('{"reply":"好"}')];
    await chatCompletion("sys", "user", {
      baseUrl: "https://api.openai-next.com/v1?api-version=2024-02-01",
      modelId: "m",
      apiKey: "k",
    });
    expect(sent[0].url).toBe(
      "https://api.openai-next.com/v1/chat/completions?api-version=2024-02-01",
    );
  });

  function probeStub(pick: (url: string) => Response) {
    const calls: { url: string; auth: string | null; body: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
        const url = String(input);
        calls.push({ url, auth: init?.headers?.authorization ?? null, body: String(init?.body ?? "") });
        return pick(url);
      }),
    );
    return calls;
  }
  const HTML = () =>
    new Response("<!doctype html><title>站点首页</title>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  const JSON401 = () =>
    new Response(JSON.stringify({ error: { message: "Invalid token." } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });

  it("探到真接口就报出前缀；探测一个字节密钥都不带", async () => {
    const calls = probeStub((url) =>
      url.includes("/v1/") ? JSON401() : HTML(),
    );
    try {
      const found = await detectApiPrefix(
        "https://api.openai-next.com/chat/completions",
      );
      expect(found).toBe("https://api.openai-next.com/v1");
      expect(calls.map((c) => c.url)).toEqual([
        "https://api.openai-next.com/v1/chat/completions",
      ]);
      // 关键隐私断言：这一下探测不带 authorization，也不带用户的 key
      expect(calls.every((c) => c.auth === null)).toBe(true);
      expect(JSON.stringify(calls)).not.toContain("sk-test-key");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("候选前缀也回网页 → 不给建议（拿猜的当结论比不说更坏）", async () => {
    const calls = probeStub(() => HTML());
    try {
      const found = await detectApiPrefix(
        "https://api.openai-next.com/chat/completions",
      );
      expect(found).toBeNull();
      expect(calls.map((c) => c.url)).toEqual([
        "https://api.openai-next.com/v1/chat/completions",
        "https://api.openai-next.com/api/v1/chat/completions",
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("网关对未知路径回 404 + JSON → 不算接口前缀（实跑撞的正是这台）", async () => {
    const calls = probeStub((url) =>
      url.includes("/api/v1/")
        ? new Response(JSON.stringify({ error: { message: "not found" } }), {
            status: 404,
            headers: { "content-type": "application/json" },
          })
        : HTML(),
    );
    try {
      expect(
        await detectApiPrefix("https://api.openai-next.com/chat/completions"),
      ).toBeNull();
      expect(calls.length).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("刚打过的那一层不重复打", async () => {
    const calls = probeStub(() => JSON401());
    try {
      const found = await detectApiPrefix(
        "https://api.openai-next.com/v1/chat/completions",
      );
      expect(found).toBe("https://api.openai-next.com/api/v1");
      expect(calls.map((c) => c.url)).toEqual([
        "https://api.openai-next.com/api/v1/chat/completions",
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

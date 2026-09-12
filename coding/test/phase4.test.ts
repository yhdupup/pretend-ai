import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createLocalApp } from "../src/server/local-server.js";
import { createPublicApp } from "../src/server/public-server.js";
import {
  CONTROL_COOKIE_NAME,
  __resetBootstrapConsumedForTests,
  getControlToken,
} from "../src/server/security/control-token.js";
import { CLAIM_COOKIE_NAME } from "../src/server/routes/public/sessions.js";
import { clearCredentials } from "../src/model/credentials.js";
import { resetTokenBudget } from "../src/model/adapter.js";
import { config } from "../src/server/config.js";
import { SettingsRepository } from "../src/server/settings/repository.js";
import { getDb } from "../src/server/db/index.js";
import type {
  AReplyResponse,
  ChatMessage,
  CreateSessionResponse,
  ProcessResponse,
  PublicSessionResponse,
  SessionDetailResponse,
} from "../src/shared/types.js";

// 阶段4 端到端（进程内走真实路由栈，不联网）：
// §9.3 的五条前置、§6.6 的一致性闸门、B 侧可见性边界、限速、确认通道。

const LOCAL_ORIGIN = "http://127.0.0.1:8787";
const PUBLIC_ORIGIN = "http://127.0.0.1:8788";

function cookieOf(header: string | null, name: string): string {
  const match = header?.match(new RegExp(`${name}=([^;]+)`));
  if (!match) throw new Error(`missing ${name} cookie`);
  return match[1];
}

async function setup() {
  const localApp = createLocalApp();
  const publicApp = createPublicApp();
  const control = cookieOf(
    (
      await localApp.request(`/api/local/bootstrap/${getControlToken()}`, {
        method: "POST",
        headers: { host: "127.0.0.1:8787", origin: LOCAL_ORIGIN },
      })
    ).headers.get("set-cookie"),
    CONTROL_COOKIE_NAME,
  );
  const localHeaders = {
    host: "127.0.0.1:8787",
    origin: LOCAL_ORIGIN,
    cookie: `${CONTROL_COOKIE_NAME}=${control}`,
  };

  const created = (await (
    await localApp.request("/api/local/sessions", {
      method: "POST",
      headers: localHeaders,
    })
  ).json()) as CreateSessionResponse;
  const sessionId = created.session.id;

  const claim = cookieOf(
    (
      await publicApp.request(`/api/public/sessions/${sessionId}/claim`, {
        method: "POST",
        headers: { host: "127.0.0.1:8788", origin: PUBLIC_ORIGIN },
      })
    ).headers.get("set-cookie"),
    CLAIM_COOKIE_NAME,
  );
  const publicHeaders = {
    host: "127.0.0.1:8788",
    origin: PUBLIC_ORIGIN,
    cookie: `${CLAIM_COOKIE_NAME}=${claim}`,
  };

  return { localApp, publicApp, localHeaders, publicHeaders, sessionId };
}

async function askB(
  publicApp: ReturnType<typeof createPublicApp>,
  publicHeaders: Record<string, string>,
  sessionId: string,
  body: string,
) {
  return publicApp.request(`/api/public/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: {
      ...publicHeaders,
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
    },
    body: JSON.stringify({ body }),
  });
}

async function processDraft(
  localApp: ReturnType<typeof createLocalApp>,
  localHeaders: Record<string, string>,
  sessionId: string,
  payload: Record<string, unknown>,
) {
  return localApp.request(`/api/local/sessions/${sessionId}/process`, {
    method: "POST",
    headers: { ...localHeaders, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

beforeEach(() => {
  __resetBootstrapConsumedForTests();
  clearCredentials();
  // 每个用例都从“本地规则 + 两个开关全开”起步，避免相互串味。
  new SettingsRepository(getDb()).saveAssist({
    mode: "rules",
    aiStyleEnabled: true,
    analysisEnabled: true,
    styleLevel: "明显",
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("设置接口", () => {
  it("GET 回 assist / model / skills，且响应里没有任何密钥字段", async () => {
    const { localApp, localHeaders } = await setup();
    const res = await localApp.request("/api/local/settings", {
      headers: localHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.assist).toMatchObject({
      mode: "rules",
      aiStyleEnabled: true,
      analysisEnabled: true,
    });
    expect(body.model).toMatchObject({
      hasKey: false,
      baseUrl: "",
      modelId: "",
    });
    const skills = body.skills as Record<string, { status: string }>;
    expect(skills.aiStyle.status).toBe("ok");
    expect(skills.analysis.status).toBe("ok");
    expect(JSON.stringify(body)).not.toMatch(/apiKey/i);
  });

  it("PUT /assist 落库并读回（模式与开关是「上次选择」，可以持久化）", async () => {
    const { localApp, localHeaders } = await setup();
    const res = await localApp.request("/api/local/settings/assist", {
      method: "PUT",
      headers: { ...localHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        mode: "manual",
        styleLevel: "浓郁",
        analysisEnabled: false,
      }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toMatchObject({
      assist: { mode: "manual", styleLevel: "浓郁", analysisEnabled: false },
    });
    const settings = new SettingsRepository(getDb()).assist();
    expect(settings.mode).toBe("manual");
    expect(settings.analysisEnabled).toBe(false);
  });

  it("PUT /model 只回视图，密钥不回显；DELETE 后 hasKey=false", async () => {
    const { localApp, localHeaders } = await setup();
    const res = await localApp.request("/api/local/settings/model", {
      method: "PUT",
      headers: { ...localHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: "http://127.0.0.1:1/v1",
        modelId: "fake-model",
        apiKey: "super-secret-key-123",
        mode: "user_model",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("super-secret-key-123");
    expect(body).toMatchObject({
      model: { hasKey: true, modelId: "fake-model" },
      accepted: true,
    });

    const status = (await (
      await localApp.request("/api/local/status", { headers: localHeaders })
    ).json()) as {
      assist?: { model: { hasKey: boolean } };
    };
    expect(status.assist?.model.hasKey).toBe(true);
    expect(JSON.stringify(status)).not.toContain("super-secret-key-123");

    await localApp.request("/api/local/settings/model", {
      method: "DELETE",
      headers: localHeaders,
    });
    const after = (await (
      await localApp.request("/api/local/settings", { headers: localHeaders })
    ).json()) as { model: { hasKey: boolean } };
    expect(after.model.hasKey).toBe(false);
  });

  it("配置非法地址时 test 接口只回类型码，不回上游原文", async () => {
    const { localApp, localHeaders } = await setup();
    await localApp.request("/api/local/settings/model", {
      method: "PUT",
      headers: { ...localHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: "not-an-url",
        modelId: "m",
        apiKey: "k",
      }),
    });
    const res = await localApp.request("/api/local/settings/model/test", {
      method: "POST",
      headers: localHeaders,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      ok: boolean;
      kind?: string;
      message?: string;
    };
    expect(body.ok).toBe(false);
    expect(body.kind).toBe("CONFIG");
    // 填了但填错 ≠ 没填：这两个码混用时 A 端文案会说「还没配密钥」，把人推向错误的一项
    expect(body.errorCode).toBe("MODEL_CONFIG_INVALID");
    expect(JSON.stringify(body)).not.toContain("not-an-url");
  });
});

// 实跑踩过：连接测试失败一律回 502 + errorCode 缺失，A 页面于是显示
// 「上游没给出能读的结果（UNKNOWN_ERROR）」——三种完全不同的成因看着一模一样。
describe("模型测试的失败种类", () => {
  async function testWith(
    baseUrl: string,
    reply: () => Response,
    retryTimes?: number,
  ) {
    const saved = config.modelRetryTimes;
    if (retryTimes !== undefined) config.modelRetryTimes = retryTimes;
    const { localApp, localHeaders } = await setup();
    await localApp.request("/api/local/settings/model", {
      method: "PUT",
      headers: { ...localHeaders, "content-type": "application/json" },
      body: JSON.stringify({ baseUrl, modelId: "fake-model", apiKey: "k" }),
    });
    vi.stubGlobal("fetch", vi.fn(async () => reply()));
    try {
      const res = await localApp.request("/api/local/settings/model/test", {
        method: "POST",
        headers: localHeaders,
      });
      return { res, body: (await res.json()) as Record<string, unknown> };
    } finally {
      vi.unstubAllGlobals();
      resetTokenBudget();
      config.modelRetryTimes = saved;
    }
  }

  it("路径下没有接口（404 空体）→ 400 + BAD_ENDPOINT + 把实际请求地址回显", async () => {
    const { res, body } = await testWith(
      "http://127.0.0.1:5678/v1/chat/completions",
      () => new Response("", { status: 404 }),
    );
    expect(res.status).toBe(400);
    expect(body).toMatchObject({
      ok: false,
      kind: "BAD_ENDPOINT",
      errorCode: "MODEL_CONFIG_INVALID",
      endpointPath: "/v1/chat/completions/chat/completions",
      httpStatus: 404,
    });
    // 文案必须落到一个具体动作上：只填到 /v1
    expect(String(body.message)).toContain("/v1");
    // 回显实际请求的完整地址（不含密钥）：用户填错的常常是主机本身，只有这一行能看出来
    expect(String(body.endpointUrl)).toContain("/chat/completions");
    expect(String(body.endpointUrl)).not.toContain("sk-");
  });

  it("200 + 空响应归 BAD_ENDPOINT，并说清回的是空（实跑见过：HTTP 200 但读不出东西）", async () => {
    const empty = await testWith(
      "http://127.0.0.1:5678",
      () => new Response("", { status: 200 }),
    );
    expect(empty.body).toMatchObject({
      kind: "BAD_ENDPOINT",
      errorCode: "MODEL_CONFIG_INVALID",
      bodyKind: "empty",
      httpStatus: 200,
    });
    expect(String(empty.body.message)).toContain("空响应");
  });

  it("200 + 网页（把首页/控制台当 API）→ BAD_ENDPOINT，正文一个字不外传", async () => {
    const html = await testWith(
      "http://127.0.0.1:5678",
      () =>
        new Response("<!doctype html><title>控制台登录</title>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    );
    expect(html.body).toMatchObject({ kind: "BAD_ENDPOINT", bodyKind: "html" });
    expect(String(html.body.message)).toContain("网页");
    // 网页正文一个字都不许带出去
    expect(JSON.stringify(html.body)).not.toContain("控制台登录");
    expect(String(html.body.endpointUrl)).toBe("http://127.0.0.1:5678/chat/completions");
  });

  it("地址对、模型名不认（404 + JSON error）→ BAD_REQUEST + 配置类 400，且不带上游原文", async () => {
    const { res, body } = await testWith(
      "http://127.0.0.1:5678/v1",
      () =>
        new Response(
          JSON.stringify({
            error: { code: "model_invalid", message: "sk-上游原文不外传" },
          }),
          { status: 404, headers: { "content-type": "application/json" } },
        ),
    );
    expect(res.status).toBe(400);
    expect(body.errorCode).toBe("MODEL_CONFIG_INVALID");
    expect(body.kind).toBe("BAD_REQUEST");
    expect(String(body.message)).toContain("fake-model");
    expect(JSON.stringify(body)).not.toContain("上游原文不外传");
  });

  it("上游真的挂了（5xx）仍然算 MODEL_UNAVAILABLE，让用户重试而不是改配置", async () => {
    const { res, body } = await testWith(
      "http://127.0.0.1:5678/v1",
      // 5xx 是可重试类，这里只验分类：把重试关掉，免得测试真的退避 1s+2s
      () => new Response("boom", { status: 503 }),
      0,
    );
    expect(res.status).toBe(502);
    expect(body).toMatchObject({
      kind: "NETWORK",
      errorCode: "MODEL_UNAVAILABLE",
    });
  });
});

// 实跑撞的第二层坑（2026-09-13）：测试只能测「内存里已保存的那套」，而保存又有
// 「三项不齐就保持原值不动」的规则 —— 于是屏幕上写着刚填的地址、报出来的错却是上一次保存的地址，
// 用户看到的是「报错跟我的操作无关」。现在测试可以带框里的值，且响应必须说清测的是哪个地址。
const OK_REPLY = () =>
  new Response(
    JSON.stringify({ choices: [{ message: { role: "assistant", content: "好" } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

describe("测的是哪一套：框里的草稿 vs 内存里已保存的", () => {
  const put = (
    localApp: { request: (p: string, i?: RequestInit) => Promise<Response> },
    localHeaders: Record<string, string>,
    payload: Record<string, string>,
  ) =>
    localApp.request("/api/local/settings/model", {
      method: "PUT",
      headers: { ...localHeaders, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

  it("带草稿测：打的是草稿地址，且内存里保存的那套一个字都没被动过", async () => {
    const { localApp, localHeaders } = await setup();
    await put(localApp, localHeaders, {
      baseUrl: "http://127.0.0.1:5678/v1",
      modelId: "saved-model",
      apiKey: "sk-saved",
    });
    const urls: string[] = [];
    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        urls.push(String(input));
        bodies.push(String(init?.body ?? ""));
        return OK_REPLY();
      }),
    );
    try {
      const res = await localApp.request("/api/local/settings/model/test", {
        method: "POST",
        headers: { ...localHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          baseUrl: "http://127.0.0.1:5678/beta",
          modelId: "draft-model",
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ ok: true, drafted: true });
      // 打的是草稿那个主机路径，不是已保存的 /v1
      expect(urls[0]).toBe("http://127.0.0.1:5678/beta/chat/completions");
      expect(bodies[0]).toContain("draft-model");
      // 密钥框留空 = 沿用已保存的那把
      expect(bodies[0]).not.toContain("sk-saved");
      expect(String(body.testedBaseUrl)).toContain("/beta/chat/completions");
    } finally {
      vi.unstubAllGlobals();
    }
    const after = (await (
      await localApp.request("/api/local/settings", { headers: localHeaders })
    ).json()) as { model: { baseUrl: string; modelId: string } };
    expect(after.model).toMatchObject({
      baseUrl: "http://127.0.0.1:5678/v1",
      modelId: "saved-model",
    });
  });

  it("不传草稿 = 测已保存的那套，响应照样回显打的地址", async () => {
    const { localApp, localHeaders } = await setup();
    await put(localApp, localHeaders, {
      baseUrl: "http://127.0.0.1:5678/v1",
      modelId: "saved-model",
      apiKey: "k",
    });
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        urls.push(String(input));
        return OK_REPLY();
      }),
    );
    try {
      const body = (await (
        await localApp.request("/api/local/settings/model/test", {
          method: "POST",
          headers: localHeaders,
        })
      ).json()) as Record<string, unknown>;
      expect(body).toMatchObject({ ok: true, drafted: false });
      expect(urls[0]).toBe("http://127.0.0.1:5678/v1/chat/completions");
      expect(String(body.testedBaseUrl)).toBe(
        "http://127.0.0.1:5678/v1/chat/completions",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("草稿里模型名是空的 → 400 且点名缺「模型名」，一个请求都不发", async () => {
    const { localApp, localHeaders } = await setup();
    await put(localApp, localHeaders, {
      baseUrl: "http://127.0.0.1:5678/v1",
      modelId: "saved-model",
      apiKey: "k",
    });
    const spy = vi.fn(async () => OK_REPLY());
    vi.stubGlobal("fetch", spy);
    try {
      const res = await localApp.request("/api/local/settings/model/test", {
        method: "POST",
        headers: { ...localHeaders, "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: "http://127.0.0.1:5678/beta", modelId: "" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.errorCode).toBe("MODEL_NOT_CONFIGURED");
      expect(String(body.message)).toContain("模型名");
      expect(String(body.message)).toContain("框里");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("地址回网页、/v1 下才是接口 → 报错给出该填的具体地址，探测不带密钥", async () => {
    const { localApp, localHeaders } = await setup();
    await put(localApp, localHeaders, {
      baseUrl: "http://127.0.0.1:5678", // 第三方给的根地址：任何路径都回一个站
      modelId: "m",
      apiKey: "sk-leak-check",
    });
    const calls: { url: string; auth: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (input: unknown, init?: { headers?: Record<string, string> }) => {
          const url = String(input);
          const headers = (init?.headers ?? {}) as Record<string, string>;
          calls.push({ url, auth: headers.authorization ?? null });
          return url.includes("/v1/")
            ? new Response(JSON.stringify({ error: { message: "Invalid token." } }), {
                status: 401,
                headers: { "content-type": "application/json" },
              })
            : new Response("<!doctype html><title>站点首页</title>", {
                status: 200,
                headers: { "content-type": "text/html; charset=utf-8" },
              });
        },
      ),
    );
    try {
      const res = await localApp.request("/api/local/settings/model/test", {
        method: "POST",
        headers: localHeaders,
      });
      const body = (await res.json()) as Record<string, unknown>;
      expect(res.status).toBe(400);
      expect(body.kind).toBe("BAD_ENDPOINT");
      // 不再是一句通用规劝，而是这台机器上验过的地址
      expect(body.suggestedBaseUrl).toBe("http://127.0.0.1:5678/v1");
      expect(String(body.message)).toContain("http://127.0.0.1:5678/v1");
      expect(String(body.message)).toContain("网页");
      // 第一发是用户那套配置（带密钥），第二发是探测（一个密钥都不带）
      expect(calls.map((c) => c.url)).toEqual([
        "http://127.0.0.1:5678/chat/completions",
        "http://127.0.0.1:5678/v1/chat/completions",
      ]);
      expect(calls[0].auth).toBe("Bearer sk-leak-check"); // 真那发当然带
      expect(calls[1].auth).toBeNull(); // 探测那一发：一个密钥都不带
      expect(JSON.stringify(body)).not.toContain("sk-leak-check");
      expect(JSON.stringify(body)).not.toContain("站点首页");
      expect(JSON.stringify(body)).not.toContain("Invalid token");
    } finally {
      vi.unstubAllGlobals();
      resetTokenBudget();
    }
  });

  it("保存只填一半 → accepted:false + missing 点名，旧配置仍在生效", async () => {
    const { localApp, localHeaders } = await setup();
    await put(localApp, localHeaders, {
      baseUrl: "http://127.0.0.1:5678/v1",
      modelId: "m",
      apiKey: "k",
    });
    const res = await put(localApp, localHeaders, {
      baseUrl: "http://127.0.0.1:5678/beta",
      modelId: "",
      apiKey: "",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      accepted: boolean;
      missing: string[];
      model: { baseUrl: string };
    };
    expect(body.accepted).toBe(false);
    expect(body.missing).toContain("modelId");
    // 没生效就是没生效：生效中的仍是旧地址，界面必须看得见这条分叉
    expect(body.model.baseUrl).toBe("http://127.0.0.1:5678/v1");
  });
});

describe("§9.3 处理草稿的前置条件", () => {
  it("没有待回复的问题 -> 409 NO_PENDING_MESSAGE", async () => {
    const { localApp, localHeaders, sessionId } = await setup();
    const res = await processDraft(localApp, localHeaders, sessionId, {
      draft: "随便写点",
      aiStyleEnabled: true,
      analysisEnabled: true,
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      "NO_PENDING_MESSAGE",
    );
  });

  it("人工模式 -> 409 MANUAL_MODE", async () => {
    const { localApp, localHeaders, publicApp, publicHeaders, sessionId } =
      await setup();
    await askB(publicApp, publicHeaders, sessionId, "在吗");
    new SettingsRepository(getDb()).saveAssist({ mode: "manual" });
    const res = await processDraft(localApp, localHeaders, sessionId, {
      draft: "在的",
      aiStyleEnabled: true,
      analysisEnabled: true,
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("MANUAL_MODE");
  });

  it("两个开关都关着 -> 409 NOTHING_TO_ENABLE，不会给一个假成功的 200", async () => {
    const { localApp, localHeaders, publicApp, publicHeaders, sessionId } =
      await setup();
    await askB(publicApp, publicHeaders, sessionId, "在吗");
    const res = await processDraft(localApp, localHeaders, sessionId, {
      draft: "明天下午 3 点前给你",
      aiStyleEnabled: false,
      analysisEnabled: false,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("NOTHING_TO_ENABLE");
    expect(body.message).toContain("设置页");
  });

  it("模型模式没配凭证 -> 409 MODEL_NOT_CONFIGURED（不发起任何网络请求）", async () => {
    const { localApp, localHeaders, publicApp, publicHeaders, sessionId } =
      await setup();
    await askB(publicApp, publicHeaders, sessionId, "在吗");
    new SettingsRepository(getDb()).saveAssist({ mode: "user_model" });
    const res = await processDraft(localApp, localHeaders, sessionId, {
      draft: "在的",
      aiStyleEnabled: true,
      analysisEnabled: true,
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      "MODEL_NOT_CONFIGURED",
    );
  });

  it("B 不能连发两条：第二条 409 MESSAGE_PENDING，A 回完才能再问", async () => {
    const { localApp, localHeaders, publicApp, publicHeaders, sessionId } =
      await setup();
    const key = randomUUID();
    const ask = (body: string, idem = randomUUID()) =>
      publicApp.request(`/api/public/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: {
          ...publicHeaders,
          "content-type": "application/json",
          "idempotency-key": idem,
        },
        body: JSON.stringify({ body }),
      });

    const first = await ask("第一问", key);
    expect(first.status).toBe(201);
    const firstId = ((await first.json()) as { message: ChatMessage }).message
      .id;

    // 同一把 key + 同一份内容重放：必须拿回缓存的那条 201，不能被自己刚上的锁挡成 409
    const replay = await ask("第一问", key);
    expect(replay.status).toBe(201);
    expect(((await replay.json()) as { message: ChatMessage }).message.id).toBe(
      firstId,
    );

    const second = await ask("第二问");
    const secondBody = (await second.json()) as {
      error: string;
      message?: string;
    };
    expect(second.status).toBe(409);
    expect(secondBody.error).toBe("MESSAGE_PENDING");
    expect(secondBody.message).toBe("对方正在输入，先等一下");

    const send = await localApp.request(
      `/api/local/sessions/${sessionId}/messages`,
      {
        method: "POST",
        headers: {
          ...localHeaders,
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
        },
        body: JSON.stringify({ body: "第一答" }),
      },
    );
    expect(send.status).toBe(201);
    expect((await ask("第二问")).status).toBe(201);
  });

  it("限速：连续两次生成拿 429，等过最小间隔就放行", async () => {
    const { localApp, localHeaders, publicApp, publicHeaders, sessionId } =
      await setup();
    await askB(
      publicApp,
      publicHeaders,
      sessionId,
      "这个方案你怎么看？具体说说理由。",
    );
    const payload = {
      draft: "我倾向先做第一版，两周后看数据再定下一步。",
      aiStyleEnabled: true,
      analysisEnabled: true,
    };
    const first = await processDraft(
      localApp,
      localHeaders,
      sessionId,
      payload,
    );
    expect(first.status).toBe(200);
    const second = await processDraft(
      localApp,
      localHeaders,
      sessionId,
      payload,
    );
    expect(second.status).toBe(429);
    expect(((await second.json()) as { error: string }).error).toBe(
      "RATE_LIMITED",
    );
  });
});

async function processed() {
  const bundle = await setup();
  await askB(
    bundle.publicApp,
    bundle.publicHeaders,
    bundle.sessionId,
    "这个今天能收尾吗？",
  );
  const res = await processDraft(
    bundle.localApp,
    bundle.localHeaders,
    bundle.sessionId,
    {
      draft: "明天下午 3 点前给你，字段名先按现在这套走。",
      aiStyleEnabled: true,
      analysisEnabled: true,
    },
  );
  expect(res.status).toBe(200);
  const result = (await res.json()) as ProcessResponse;
  return { ...bundle, result };
}

function send(
  bundle: {
    localApp: ReturnType<typeof createLocalApp>;
    localHeaders: Record<string, string>;
    sessionId: string;
  },
  body: Record<string, unknown>,
) {
  return bundle.localApp.request(
    `/api/local/sessions/${bundle.sessionId}/messages`,
    {
      method: "POST",
      headers: {
        ...bundle.localHeaders,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      body: JSON.stringify(body),
    },
  );
}

describe("§6.6 生成结果与发送的一致性", () => {
  it("带 processId 且正文没改：摘要随这条回复落到 B 侧", async () => {
    const bundle = await processed();
    const res = await send(bundle, {
      body: bundle.result.reply,
      processId: bundle.result.processId,
    });
    expect(res.status).toBe(201);
    const reply = (await res.json()) as AReplyResponse;
    expect(reply.message.analysisSummary).toBe(bundle.result.analysisSummary);
    expect(reply.countedRound).toBe(true);

    const poll = (await (
      await bundle.publicApp.request(
        `/api/public/sessions/${bundle.sessionId}/poll`,
        { headers: bundle.publicHeaders },
      )
    ).json()) as { messages: Array<Record<string, unknown>> };
    const aMessage = poll.messages.find((m) => m.sender === "A");
    expect(aMessage?.analysisSummary).toBe(bundle.result.analysisSummary);
    // §8.3：模式、Skill 版本、processId 一律不出 B 侧
    expect(aMessage?.assist).toBeUndefined();
    expect("assist" in (aMessage ?? {})).toBe(false);
    expect(JSON.stringify(poll)).not.toMatch(
      /rules|skillRefs|contentHash|processId/i,
    );
  });

  it("A 改了正文没重新处理：409 ANALYSIS_STALE，摘要不会跟着发出去", async () => {
    const bundle = await processed();
    const res = await send(bundle, {
      body: `${bundle.result.reply} 对了再加一句。`,
      processId: bundle.result.processId,
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      "ANALYSIS_STALE",
    );
    // 没发出去 => 轮次没涨、B 那边也看不到任何东西
    const detail = (await (
      await bundle.localApp.request(`/api/local/sessions/${bundle.sessionId}`, {
        headers: bundle.localHeaders,
      })
    ).json()) as SessionDetailResponse;
    expect(detail.roundCount).toBe(0);
    const poll = (await (
      await bundle.publicApp.request(
        `/api/public/sessions/${bundle.sessionId}/poll`,
        { headers: bundle.publicHeaders },
      )
    ).json()) as { messages: ChatMessage[] };
    expect(poll.messages.some((m) => m.sender === "A")).toBe(false);
  });

  it("A 不带 processId 直接发：照常发送成功，摘要为空（人工原文路径）", async () => {
    const bundle = await processed();
    const res = await send(bundle, { body: "我自己写的一句话" });
    expect(res.status).toBe(201);
    const reply = (await res.json()) as AReplyResponse;
    expect(reply.message.analysisSummary ?? null).toBeNull();
    expect(reply.message.assist).toBeUndefined();
  });

  it("过期的 processId 视为不一致", async () => {
    const bundle = await processed();
    const res = await send(bundle, {
      body: bundle.result.reply,
      processId: "not-a-real-process",
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      "ANALYSIS_STALE",
    );
  });

  it("确认通道：改过正文后显式确认，才能带着同一条摘要发出去", async () => {
    const bundle = await processed();
    const edited = `${bundle.result.reply}另外先别写测试。`;
    const confirm = await bundle.localApp.request(
      `/api/local/sessions/${bundle.sessionId}/process/${bundle.result.processId}/confirm`,
      {
        method: "POST",
        headers: { ...bundle.localHeaders, "content-type": "application/json" },
        body: JSON.stringify({ reply: edited }),
      },
    );
    expect(confirm.status).toBe(200);
    const res = await send(bundle, {
      body: edited,
      processId: bundle.result.processId,
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as AReplyResponse).message.analysisSummary).toBe(
      bundle.result.analysisSummary,
    );
  });

  it("确认的摘要自己也要过闸：泄露内部用词的一律 422", async () => {
    const bundle = await processed();
    const res = await bundle.localApp.request(
      `/api/local/sessions/${bundle.sessionId}/process/${bundle.result.processId}/confirm`,
      {
        method: "POST",
        headers: { ...bundle.localHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          analysisSummary: "这是我照着草稿在后台规则模式里拼的",
        }),
      },
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe(
      "INVALID_MODEL_OUTPUT",
    );
  });

  it("确认过的摘要会随回复发给 B（A 手写也算“已确认”）", async () => {
    const bundle = await processed();
    const manual =
      "我先确认你问的是收尾时间，再看有没有卡住的前提，然后给一个能验证的节点。";
    const confirm = await bundle.localApp.request(
      `/api/local/sessions/${bundle.sessionId}/process/${bundle.result.processId}/confirm`,
      {
        method: "POST",
        headers: { ...bundle.localHeaders, "content-type": "application/json" },
        body: JSON.stringify({ analysisSummary: manual }),
      },
    );
    expect(confirm.status).toBe(200);
    const res = await send(bundle, {
      body: bundle.result.reply,
      processId: bundle.result.processId,
    });
    expect(((await res.json()) as AReplyResponse).message.analysisSummary).toBe(
      manual,
    );
  });
});

describe("A 手写摘要（analysisManual）", () => {
  async function askAndProcess(payload: Record<string, unknown>) {
    const bundle = await setup();
    await askB(
      bundle.publicApp,
      bundle.publicHeaders,
      bundle.sessionId,
      "这个今天能收尾吗？",
    );
    const res = await processDraft(
      bundle.localApp,
      bundle.localHeaders,
      bundle.sessionId,
      payload,
    );
    // 成功和失败共用一条读取路径：Body 只能读一次。
    const body = (await res.json()) as ProcessResponse & {
      error?: string;
      message?: string;
    };
    return { bundle, res, body };
  }

  it("A 写好过程再点处理：正文照常润色，摘要用 A 的那句、不再被覆盖", async () => {
    const manual =
      "我先确认你要的是时间点还是可验收的样子，再看有没有卡住的前提。";
    const { bundle, res, body } = await askAndProcess({
      draft: "明天下午 3 点前给你，字段名先按现在这套走。",
      aiStyleEnabled: true,
      analysisEnabled: true,
      analysisManual: manual,
    });
    expect(res.status).toBe(200);
    expect(body.analysisSummary).toBe(manual);
    // 正文仍然是规则改写过的（不是 A 那句摘要）
    expect(body.reply).toContain("明天下午 3 点前给你");
    const send = await bundle.localApp.request(
      `/api/local/sessions/${bundle.sessionId}/messages`,
      {
        method: "POST",
        headers: {
          ...bundle.localHeaders,
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
        },
        body: JSON.stringify({ body: body.reply, processId: body.processId }),
      },
    );
    expect(send.status).toBe(201);
    expect(
      ((await send.json()) as AReplyResponse).message.analysisSummary,
    ).toBe(manual);
  });

  it("手写摘要也要过同一套闸：出现内部用词直接 422，什么都不落库", async () => {
    const { bundle, res, body } = await askAndProcess({
      draft: "明天下午 3 点前给你。",
      aiStyleEnabled: true,
      analysisEnabled: true,
      analysisManual: "这是我根据草稿在后台按规则模式拼给对方的",
    });
    expect(res.status).toBe(422);
    expect(body.error).toBe("INVALID_MODEL_OUTPUT");
    // 失败原因要说清是哪一项，但不能把 A 写的那段原样贴回去（日志里也不该有）
    expect(typeof body.message).toBe("string");
    expect(body.processId).toBeUndefined();
    const detail = (await (
      await bundle.localApp.request(`/api/local/sessions/${bundle.sessionId}`, {
        headers: bundle.localHeaders,
      })
    ).json()) as SessionDetailResponse;
    expect(detail.messages.some((m) => m.sender === "A")).toBe(false);
  });

  it("摘要开关关着时，手写的那段一并忽略（§6.5：关了就什么都不显示）", async () => {
    const { body } = await askAndProcess({
      draft: "明天下午 3 点前给你。",
      aiStyleEnabled: true,
      analysisEnabled: false,
      analysisManual: "这句本来不该出现在 B 那边",
    });
    expect(body.analysisSummary).toBe("");
  });
});

describe("A 侧可见性", () => {
  it("会话详情带 assist 元信息，B 侧只带摘要", async () => {
    const bundle = await processed();
    await send(bundle, {
      body: bundle.result.reply,
      processId: bundle.result.processId,
    });
    const detail = (await (
      await bundle.localApp.request(`/api/local/sessions/${bundle.sessionId}`, {
        headers: bundle.localHeaders,
      })
    ).json()) as SessionDetailResponse;
    const aMessage = detail.messages.find((m) => m.sender === "A");
    expect(aMessage?.assist?.mode).toBe("rules");
    expect(aMessage?.assist?.skillRefs?.length).toBeGreaterThan(0);
    expect(detail.generating).toBe(false);

    const publicView = (await (
      await bundle.publicApp.request(
        `/api/public/sessions/${bundle.sessionId}`,
        { headers: bundle.publicHeaders },
      )
    ).json()) as PublicSessionResponse;
    expect(
      publicView.messages.find((m) => m.sender === "A")?.analysisSummary,
    ).toBeTruthy();
    expect(
      publicView.messages.find((m) => m.sender === "A")?.assist,
    ).toBeUndefined();
  });

  it("只关 AI 味、留摘要：正文逐字等于草稿，摘要照旧生成", async () => {
    const bundle = await setup();
    await askB(
      bundle.publicApp,
      bundle.publicHeaders,
      bundle.sessionId,
      "这个今天能收尾吗？",
    );
    const draft = "明天下午 3 点前给你。";
    const res = await processDraft(
      bundle.localApp,
      bundle.localHeaders,
      bundle.sessionId,
      {
        draft,
        aiStyleEnabled: false,
        analysisEnabled: true,
      },
    );
    const result = (await res.json()) as ProcessResponse;
    expect(result.reply).toBe(draft);
    expect(result.analysisSummary.length).toBeGreaterThan(10);
  });
});

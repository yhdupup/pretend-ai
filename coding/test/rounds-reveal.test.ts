import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalApp } from "../src/server/local-server.js";
import { createPublicApp } from "../src/server/public-server.js";
import {
  CONTROL_COOKIE_NAME,
  __resetBootstrapConsumedForTests,
  getControlToken,
} from "../src/server/security/control-token.js";
import { CLAIM_COOKIE_NAME } from "../src/server/routes/public/sessions.js";
import { config } from "../src/server/config.js";
import type {
  AReplyResponse,
  ClaimResponse,
  CreateSessionResponse,
  HeartbeatResponse,
  PollResponse,
  PreviewResponse,
  PublicSessionResponse,
  SessionDetailResponse,
} from "../src/shared/types.js";

// 阶段2 缺口2/3/4/5 的 HTTP 层测试：走真实路由栈（localAuth + whitelist + claim）。
// 只测跨入口的行为（轮次、自动揭晓、心跳、关闭清理、绑定前预览），
// 时间边界与事务原子性在 test/maintenance.test.ts 用注入时钟覆盖。

const LOCAL_ORIGIN = "http://127.0.0.1:8787";
const PUBLIC_ORIGIN = "http://127.0.0.1:8788";

const localApp = createLocalApp();
const publicApp = createPublicApp();

let localCookie = "";
let local = 0;

function extractCookieValue(
  setCookieHeader: string | null,
  cookieName: string,
): string | null {
  if (!setCookieHeader) return null;
  const match = setCookieHeader.match(new RegExp(`${cookieName}=([^;]+)`));
  return match?.[1] ?? null;
}

function localHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    host: "127.0.0.1:8787",
    origin: LOCAL_ORIGIN,
    cookie: localCookie,
    ...extra,
  };
}

function publicHeaders(
  claimValue: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    host: "127.0.0.1:8788",
    origin: PUBLIC_ORIGIN,
    cookie: `${CLAIM_COOKIE_NAME}=${claimValue}`,
    ...extra,
  };
}

// 路由测试写的是真实文件库（data/dev.sqlite），测完必须自己关掉会话，
// 否则这些“永远没人再来收”的会话会一直留在开发库里。
const opened: string[] = [];

async function createSession(
  body?: unknown,
): Promise<{ id: string; claim: string }> {
  const res = await localApp.request("/api/local/sessions", {
    method: "POST",
    headers: localHeaders({ "content-type": "application/json" }),
    body: body ? JSON.stringify(body) : undefined,
  });
  expect(res.status).toBe(201);
  const created = (await res.json()) as CreateSessionResponse;
  const claimRes = await publicApp.request(
    `/api/public/sessions/${created.session.id}/claim`,
    {
      method: "POST",
      headers: { host: "127.0.0.1:8788", origin: PUBLIC_ORIGIN },
    },
  );
  expect(claimRes.status).toBe(200);
  const claim = extractCookieValue(
    claimRes.headers.get("set-cookie"),
    CLAIM_COOKIE_NAME,
  ) as string;
  opened.push(created.session.id);
  return { id: created.session.id, claim };
}

// B 提问 + A 回答 = 一个完整轮次（PRD §5.2）
async function oneRound(
  sessionId: string,
  claimCookie: string,
  n: number,
): Promise<AReplyResponse> {
  const ask = await publicApp.request(
    `/api/public/sessions/${sessionId}/messages`,
    {
      method: "POST",
      headers: publicHeaders(claimCookie, {
        "content-type": "application/json",
        "idempotency-key": `round-q-${n}`,
      }),
      body: JSON.stringify({ body: `问题 ${n}` }),
    },
  );
  expect(ask.status).toBe(201);

  const reply = await localApp.request(
    `/api/local/sessions/${sessionId}/messages`,
    {
      method: "POST",
      headers: localHeaders({
        "content-type": "application/json",
        "idempotency-key": `round-a-${n}`,
      }),
      body: JSON.stringify({ body: `回答 ${n}` }),
    },
  );
  expect(reply.status).toBe(201);
  return (await reply.json()) as AReplyResponse;
}

afterEach(async () => {
  for (const id of opened.splice(0)) {
    await localApp.request(`/api/local/sessions/${id}/close`, {
      method: "POST",
      headers: localHeaders(),
    });
  }
});

beforeEach(async () => {
  __resetBootstrapConsumedForTests();
  local++;
  const bootstrapRes = await localApp.request(
    `/api/local/bootstrap/${getControlToken()}`,
    {
      method: "POST",
      headers: { host: "127.0.0.1:8787", origin: LOCAL_ORIGIN },
    },
  );
  expect(bootstrapRes.status).toBe(200);
  localCookie = `${CONTROL_COOKIE_NAME}=${extractCookieValue(
    bootstrapRes.headers.get("set-cookie"),
    CONTROL_COOKIE_NAME,
  )}`;
});

describe("系统屏蔽词的公开端到端边界", () => {
  it("A 回复命中后给出提示，B 轮询拿不到原词", async () => {
    const { id, claim } = await createSession({
      aiName: "银行客服",
      openingMessage: "请打开投屏",
    });

    const previewRes = await publicApp.request(
      `/api/public/sessions/${id}/preview`,
      { headers: { host: "127.0.0.1:8788", origin: PUBLIC_ORIGIN } },
    );
    const preview = (await previewRes.json()) as PreviewResponse;
    expect(preview.aiName).toBe("＊＊客服");
    expect(preview.openingMessage).toBe("请打开＊＊");

    const askRes = await publicApp.request(
      `/api/public/sessions/${id}/messages`,
      {
        method: "POST",
        headers: publicHeaders(claim, {
          "content-type": "application/json",
          "idempotency-key": "filter-question",
        }),
        body: JSON.stringify({ body: "你想说什么？" }),
      },
    );
    const asked = (await askRes.json()) as { message: { id: string } };

    const replyRes = await localApp.request(
      `/api/local/sessions/${id}/messages`,
      {
        method: "POST",
        headers: localHeaders({
          "content-type": "application/json",
          "idempotency-key": "filter-reply",
        }),
        body: JSON.stringify({ body: "把钱转 账到支付宝并打开投屏" }),
      },
    );
    expect(replyRes.status).toBe(201);
    const reply = (await replyRes.json()) as AReplyResponse;
    expect(reply.contentFilter).toEqual({ applied: true, matchedCount: 4 });

    const pollRes = await publicApp.request(
      `/api/public/sessions/${id}/poll?after=${asked.message.id}`,
      { headers: publicHeaders(claim) },
    );
    const poll = (await pollRes.json()) as PollResponse;
    const body = poll.messages[0]?.body ?? "";
    expect(body).toBe("把＊＊＊到＊＊＊并打开＊＊");
    expect(body).not.toMatch(/钱|转|账|支付宝|投屏/);
  });
});

describe("缺口2/3：轮次计数与自动揭晓", () => {
  it("第 10 轮回复把会话置为已揭晓，原因是 ROUND_LIMIT，并通过 B 轮询带回揭晓信息", async () => {
    const { id, claim } = await createSession();

    for (let n = 1; n <= config.roundLimit - 1; n++) {
      const result = await oneRound(id, claim, n);
      expect(result.roundCount).toBe(n);
      expect(result.session.revealState).toBe("HIDDEN");
    }

    const last = await oneRound(id, claim, config.roundLimit);
    expect(last.roundCount).toBe(config.roundLimit);
    expect(last.session.revealState).toBe("REVEALED");
    expect(last.session.revealReason).toBe("ROUND_LIMIT");
    expect(last.session.state).toBe("ACTIVE"); // 揭晓 != 关闭

    const pollRes = await publicApp.request(`/api/public/sessions/${id}/poll`, {
      headers: publicHeaders(claim),
    });
    expect(pollRes.status).toBe(200);
    const poll = (await pollRes.json()) as PollResponse;
    expect(poll.completedRounds).toBe(config.roundLimit);
    expect(poll.reveal).not.toBeNull();
    expect(poll.reveal?.reason).toBe("ROUND_LIMIT");
  });

  it("揭晓前 B 侧看不到 A 的身份；揭晓后才能看到名称、头像和留言", async () => {
    const { id, claim } = await createSession({
      aiName: "小雷 AI",
      avatarId: "robot-02",
      openingMessage: "你好，随便问",
      revealMessage: "其实是活人",
    });

    const before = (await (
      await publicApp.request(`/api/public/sessions/${id}`, {
        headers: publicHeaders(claim),
      })
    ).json()) as PublicSessionResponse;
    expect(before.reveal).toBeNull();
    expect(before.aiName).toBe("小雷 AI");
    expect(JSON.stringify(before)).not.toContain("其实是活人");
    expect(JSON.stringify(before)).not.toContain("小李");

    const revealRes = await localApp.request(
      `/api/local/sessions/${id}/reveal`,
      {
        method: "POST",
        headers: localHeaders(),
      },
    );
    expect(revealRes.status).toBe(200);

    const after = (await (
      await publicApp.request(`/api/public/sessions/${id}/poll`, {
        headers: publicHeaders(claim),
      })
    ).json()) as PollResponse;
    expect(after.reveal).toMatchObject({
      state: "REVEALED",
      reason: "OWNER_ACTION",
      message: "其实是活人",
      avatarId: expect.any(String),
    });
  });

  it("B 单独发送不计轮次；A 在没有待回复问题时发言也不计轮次（PRD §5.2）", async () => {
    const { id, claim } = await createSession();
    const ask = await publicApp.request(`/api/public/sessions/${id}/messages`, {
      method: "POST",
      headers: publicHeaders(claim, {
        "content-type": "application/json",
        "idempotency-key": `solo-q-${local}`,
      }),
      body: JSON.stringify({ body: "没人回答我" }),
    });
    expect(ask.status).toBe(201);

    let view = (await (
      await localApp.request(`/api/local/sessions/${id}`, {
        headers: localHeaders(),
      })
    ).json()) as SessionDetailResponse;
    expect(view.roundCount).toBe(0);
    expect(view.pending[0]?.state).toBe("WAITING_A");

    // 全新会话里没有任何待回复问题，A 主动发言不推进轮次
    const fresh = await createSession();
    const stray = await localApp.request(
      `/api/local/sessions/${fresh.id}/messages`,
      {
        method: "POST",
        headers: localHeaders({
          "content-type": "application/json",
          "idempotency-key": `stray-${fresh.id}`,
        }),
        body: JSON.stringify({ body: "A 主动插话" }),
      },
    );
    const strayBody = (await stray.json()) as AReplyResponse;
    expect(strayBody.countedRound).toBe(false);
    expect(strayBody.roundCount).toBe(0);

    view = (await (
      await localApp.request(`/api/local/sessions/${fresh.id}`, {
        headers: localHeaders(),
      })
    ).json()) as SessionDetailResponse;
    expect(view.roundCount).toBe(0);
    expect(view.messages).toHaveLength(1);
  });

  it("同一 Idempotency-Key 重放不会增加轮次", async () => {
    const { id, claim } = await createSession();
    await publicApp.request(`/api/public/sessions/${id}/messages`, {
      method: "POST",
      headers: publicHeaders(claim, {
        "content-type": "application/json",
        "idempotency-key": `dup-q-${local}`,
      }),
      body: JSON.stringify({ body: "会被重复回答" }),
    });

    const url = `/api/local/sessions/${id}/messages`;
    const init = {
      method: "POST",
      headers: localHeaders({
        "content-type": "application/json",
        "idempotency-key": `dup-a-${local}`,
      }),
      body: JSON.stringify({ body: "只算一轮" }),
    };
    const first = (await (
      await localApp.request(url, init)
    ).json()) as AReplyResponse;
    const replay = (await (
      await localApp.request(url, init)
    ).json()) as AReplyResponse;
    expect(replay).toEqual(first);
    expect(replay.roundCount).toBe(1);

    const view = (await (
      await localApp.request(`/api/local/sessions/${id}`, {
        headers: localHeaders(),
      })
    ).json()) as SessionDetailResponse;
    expect(view.roundCount).toBe(1);
    expect(view.messages.filter((m) => m.sender === "A")).toHaveLength(1);
  });
});

describe("缺口4：心跳与清理", () => {
  it("A 心跳写入最近在线时间；会话不存在时 404", async () => {
    const { id } = await createSession();
    const res = await localApp.request(`/api/local/sessions/${id}/heartbeat`, {
      method: "POST",
      headers: localHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as HeartbeatResponse;
    expect(body.ok).toBe(true);
    expect(body.lastOwnerHeartbeatAt).toBeTruthy();

    const missing = await localApp.request(
      `/api/local/sessions/does-not-exist/heartbeat`,
      {
        method: "POST",
        headers: localHeaders(),
      },
    );
    expect(missing.status).toBe(404);
  });

  it("A 主动关闭 -> 会话数据立即删除，B 侧两条路径都变 404", async () => {
    const { id, claim } = await createSession();
    await oneRound(id, claim, 1);

    const closeRes = await localApp.request(`/api/local/sessions/${id}/close`, {
      method: "POST",
      headers: localHeaders(),
    });
    expect(closeRes.status).toBe(200);

    expect(
      (
        await localApp.request(`/api/local/sessions/${id}`, {
          headers: localHeaders(),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await publicApp.request(`/api/public/sessions/${id}/poll`, {
          headers: publicHeaders(claim),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await publicApp.request(`/api/public/sessions/${id}/messages`, {
          method: "POST",
          headers: publicHeaders(claim, {
            "content-type": "application/json",
            "idempotency-key": `after-close-${id}`,
          }),
          body: JSON.stringify({ body: "还在吗" }),
        })
      ).status,
    ).toBe(404);
    // 关闭是幂等的：重复关闭不再返回 200，而是与会话不存在一致
    expect(
      (
        await localApp.request(`/api/local/sessions/${id}/close`, {
          method: "POST",
          headers: localHeaders(),
        })
      ).status,
    ).toBe(404);
  });
});

describe("缺口5：绑定前预览与本机身份设置", () => {
  it("preview 不需要 Cookie，也不返回 A 的身份", async () => {
    const createRes = await localApp.request("/api/local/sessions", {
      method: "POST",
      headers: localHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        aiName: "小雷 AI",
        avatarId: "robot-03",
        openingMessage: "随便问点什么",
      }),
    });
    const created = (await createRes.json()) as CreateSessionResponse;
    const id = created.session.id;
    opened.push(id);

    const preview = (await (
      await publicApp.request(`/api/public/sessions/${id}/preview`, {
        headers: { host: "127.0.0.1:8788", origin: PUBLIC_ORIGIN },
      })
    ).json()) as PreviewResponse;
    expect(preview).toMatchObject({
      aiName: "小雷 AI",
      avatarId: "robot-03",
      openingMessage: "随便问点什么",
    });
    expect(preview.state).toBe("WAITING");
    // 两个上限随预览下发：B 端的揭晓文案（“聊满了 N 轮”/“到了 N 分钟”）要用它们拼，
    // 写在代码里就会在 TIME_LIMIT_MINUTES 一改之后与规则对不上。
    expect(preview.roundLimit).toBe(config.roundLimit);
    expect(preview.timeLimitMinutes).toBe(config.timeLimitMinutes);

    // 没带凭证直接查详情仍是 404（不泄露“存在但未绑定”）
    expect(
      (
        await publicApp.request(`/api/public/sessions/${id}`, {
          headers: { host: "127.0.0.1:8788", origin: PUBLIC_ORIGIN },
        })
      ).status,
    ).toBe(404);

    await localApp.request(`/api/local/sessions/${id}/close`, {
      method: "POST",
      headers: localHeaders(),
    });
  });

  it("创建会话时头像编号非法会被拒绝", async () => {
    const res = await localApp.request("/api/local/sessions", {
      method: "POST",
      headers: localHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        aiName: "X",
        avatarId: "http://evil/a.png",
        openingMessage: "hi",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("A 身份可以在设置里改，改完创建的会话才用新值（旧会话保留快照）", async () => {
    const bad = await localApp.request("/api/local/settings/profile", {
      method: "PUT",
      headers: localHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        ownerName: "",
        ownerAvatarId: "robot-01",
        defaultRevealMessage: "x",
      }),
    });
    expect(bad.status).toBe(400);

    const put = await localApp.request("/api/local/settings/profile", {
      method: "PUT",
      headers: localHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        ownerName: `张三${local}`,
        ownerAvatarId: "robot-04",
        defaultRevealMessage: "被你发现啦",
      }),
    });
    expect(put.status).toBe(200);

    const get = (await (
      await localApp.request("/api/local/settings", { headers: localHeaders() })
    ).json()) as { profile: { ownerName: string } };
    expect(get.profile.ownerName).toBe(`张三${local}`);

    const created = await createSession({
      aiName: "小雷 AI",
      avatarId: "robot-01",
      openingMessage: "你好",
    });
    const revealRes = await localApp.request(
      `/api/local/sessions/${created.id}/reveal`,
      {
        method: "POST",
        headers: localHeaders(),
      },
    );
    const revealed = (await revealRes.json()) as {
      session: SessionDetailResponse["session"];
    };
    expect(revealed.session.profile.ownerName).toBe(`张三${local}`);
    expect(revealed.session.profile.revealMessage).toBe("被你发现啦");

    const poll = (await (
      await publicApp.request(`/api/public/sessions/${created.id}/poll`, {
        headers: publicHeaders(created.claim),
      })
    ).json()) as PollResponse;
    expect(poll.reveal).toMatchObject({
      ownerName: `张三${local}`,
      message: "被你发现啦",
      avatarId: "robot-04",
    });

    await localApp.request(`/api/local/sessions/${created.id}/close`, {
      method: "POST",
      headers: localHeaders(),
    });
  });
});

// ── 文案与常量不许各说各话 ───────────────────────────────────────────────
// 「多少分钟自动揭晓」这个数会出现在四个地方：服务端默认值、A 首页那句说明、
// A 与 B 的揭晓原因文案。后两处现在从载荷拿（不再写死），但首页那句是静态文案，
// 改默认值时最容易漏 —— 所以拿源码比一遍。
describe("揭晓时长常量的口径一致", () => {
  it("默认值是 20 分钟（作者 2026-09-12 要求从 10 改上来）", () => {
    expect(config.timeLimitMinutes).toBe(20);
    expect(config.roundLimit).toBe(10);
  });

  it("A 首页那句说明里的轮次与分钟数跟服务端默认值一致", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      "apps/a-frontend/src/pages/HomePage.tsx",
      "utf8",
    ).replace(/\s+/g, " ");
    expect(src).toContain(
      `第 ${config.roundLimit} 轮或 ${config.timeLimitMinutes} 分钟后揭晓是你`,
    );
  });

  it("两个前端的揭晓文案里不再写死分钟数", async () => {
    const { readFileSync } = await import("node:fs");
    for (const p of [
      "apps/a-frontend/src/pages/SessionPage.tsx",
      "apps/b-frontend/src/pages/SessionPage.tsx",
    ]) {
      // 只看渲染成字符串的那些行：注释里提一句「以前写死 10 分钟」是允许的
      const codeLines = readFileSync(p, "utf8")
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join("\n");
      expect(/\d+ ?分钟/.test(codeLines)).toBe(false);
      expect(codeLines).toContain("timeLimitMinutes");
    }
  });
});

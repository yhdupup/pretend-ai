import { describe, expect, it } from "vitest";
import { createPublicApp } from "../src/server/public-server.js";
import { createLocalApp } from "../src/server/local-server.js";
import {
  CONTROL_COOKIE_NAME,
  __resetBootstrapConsumedForTests,
  getControlToken,
} from "../src/server/security/control-token.js";
import { CLAIM_COOKIE_NAME } from "../src/server/routes/public/sessions.js";
import type {
  ClaimResponse,
  CreateSessionResponse,
} from "../src/shared/types.js";

// 阶段2 缺口1（单B绑定）的HTTP层测试。数据库层的互斥语义（claims.session_id UNIQUE 约束）
// 已在 test/repository.test.ts 里单独覆盖；这里测的是路由层如何把该约束翻译成HTTP语义：
// 成功绑定 -> 200 + Set-Cookie，重复绑定 -> 409，未绑定/凭证不匹配访问受保护路由 -> 404
// （沿用"不可区分404"原则，见 sessions.ts 的 verifyClaim 注释）。

const LOCAL_ORIGIN = "http://127.0.0.1:8787";
const PUBLIC_ORIGIN = "http://127.0.0.1:8788";

function extractCookieValue(
  setCookieHeader: string | null,
  cookieName: string,
): string | null {
  if (!setCookieHeader) return null;
  const match = setCookieHeader.match(new RegExp(`${cookieName}=([^;]+)`));
  return match?.[1] ?? null;
}

// 复用 local-auth-bootstrap.test.ts 里验证过的 bootstrap 流程，只是为了拿到一个真实
// 存在的 session id（claim 路由需要一个真实会话才能测试，不能只测 404 分支）。
async function createSession(): Promise<string> {
  __resetBootstrapConsumedForTests();
  const localApp = createLocalApp();
  const token = getControlToken();
  const bootstrapRes = await localApp.request(`/api/local/bootstrap/${token}`, {
    method: "POST",
    headers: { host: "127.0.0.1:8787", origin: LOCAL_ORIGIN },
  });
  const cookie = extractCookieValue(
    bootstrapRes.headers.get("set-cookie"),
    CONTROL_COOKIE_NAME,
  );

  const createRes = await localApp.request("/api/local/sessions", {
    method: "POST",
    headers: {
      host: "127.0.0.1:8787",
      origin: LOCAL_ORIGIN,
      cookie: `${CONTROL_COOKIE_NAME}=${cookie}`,
    },
  });
  const created = (await createRes.json()) as CreateSessionResponse;
  return created.session.id;
}

describe("claim (单B绑定)", () => {
  it("returns 404 when claiming a session that does not exist", async () => {
    const publicApp = createPublicApp();
    const res = await publicApp.request(
      "/api/public/sessions/does-not-exist/claim",
      {
        method: "POST",
        headers: { host: "127.0.0.1:8788", origin: PUBLIC_ORIGIN },
      },
    );
    expect(res.status).toBe(404);
  });

  it("first claim succeeds with 200 + ok:true + Set-Cookie", async () => {
    const sessionId = await createSession();
    const publicApp = createPublicApp();
    const res = await publicApp.request(
      `/api/public/sessions/${sessionId}/claim`,
      {
        method: "POST",
        headers: { host: "127.0.0.1:8788", origin: PUBLIC_ORIGIN },
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ClaimResponse;
    expect(body.ok).toBe(true);
    expect(
      extractCookieValue(res.headers.get("set-cookie"), CLAIM_COOKIE_NAME),
    ).not.toBeNull();
  });

  it("a second sequential claim on an already-claimed session returns 409 LINK_ALREADY_CLAIMED", async () => {
    const sessionId = await createSession();
    const publicApp = createPublicApp();
    const headers = { host: "127.0.0.1:8788", origin: PUBLIC_ORIGIN };

    const first = await publicApp.request(
      `/api/public/sessions/${sessionId}/claim`,
      {
        method: "POST",
        headers,
      },
    );
    expect(first.status).toBe(200);

    const second = await publicApp.request(
      `/api/public/sessions/${sessionId}/claim`,
      {
        method: "POST",
        headers,
      },
    );
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: string };
    expect(body.error).toBe("LINK_ALREADY_CLAIMED");
  });

  it("concurrent claims on the same session: exactly one 200, the rest 409 (UNIQUE约束互斥)", async () => {
    const sessionId = await createSession();
    const publicApp = createPublicApp();
    const headers = { host: "127.0.0.1:8788", origin: PUBLIC_ORIGIN };

    // 同时发起5次绑定请求，模拟并发。数据库层的 claims.session_id UNIQUE 约束是唯一的
    // 互斥保证（不依赖应用层锁），因此无论并发度多高，应恰好一次成功。
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        publicApp.request(`/api/public/sessions/${sessionId}/claim`, {
          method: "POST",
          headers,
        }),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409, 409, 409, 409]);
  });

  it("rejects access to protected routes with no claim cookie (404, 不可区分原则)", async () => {
    const sessionId = await createSession();
    const publicApp = createPublicApp();
    // 该会话真实存在，但从未绑定；GET /:id 不应因此暴露"存在但未绑定"的403信号。
    const res = await publicApp.request(`/api/public/sessions/${sessionId}`, {
      headers: { host: "127.0.0.1:8788", origin: PUBLIC_ORIGIN },
    });
    expect(res.status).toBe(404);
  });

  it("rejects access with a tampered/wrong claim cookie (404, hash mismatch)", async () => {
    const sessionId = await createSession();
    const publicApp = createPublicApp();
    const headers = { host: "127.0.0.1:8788", origin: PUBLIC_ORIGIN };

    const claimRes = await publicApp.request(
      `/api/public/sessions/${sessionId}/claim`,
      {
        method: "POST",
        headers,
      },
    );
    const realCookie = extractCookieValue(
      claimRes.headers.get("set-cookie"),
      CLAIM_COOKIE_NAME,
    );
    expect(realCookie).not.toBeNull();

    // 伪造一个凭证值（哈希不会匹配 claims 表里记录的哈希）。
    const res = await publicApp.request(`/api/public/sessions/${sessionId}`, {
      headers: {
        ...headers,
        cookie: `${CLAIM_COOKIE_NAME}=not-the-real-credential`,
      },
    });
    expect(res.status).toBe(404);
  });

  it("accepts access with the correct claim cookie after a successful claim", async () => {
    const sessionId = await createSession();
    const publicApp = createPublicApp();
    const headers = { host: "127.0.0.1:8788", origin: PUBLIC_ORIGIN };

    const claimRes = await publicApp.request(
      `/api/public/sessions/${sessionId}/claim`,
      {
        method: "POST",
        headers,
      },
    );
    const realCookie = extractCookieValue(
      claimRes.headers.get("set-cookie"),
      CLAIM_COOKIE_NAME,
    );

    const res = await publicApp.request(`/api/public/sessions/${sessionId}`, {
      headers: { ...headers, cookie: `${CLAIM_COOKIE_NAME}=${realCookie}` },
    });
    expect(res.status).toBe(200);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { config } from "../src/server/config";
import { createPublicApp } from "../src/server/public-server";
import { createLocalApp } from "../src/server/local-server";
import { getDb } from "../src/server/db/index";
import { SessionRepository } from "../src/server/session/repository";
import {
  closeAllSessions,
  markLinksInvalidated,
} from "../src/server/session/maintenance";
import { memoryStore } from "../src/server/session/memory-store";
import {
  __resetBootstrapConsumedForTests,
  CONTROL_COOKIE_NAME,
  getControlToken,
} from "../src/server/security/control-token";
import type { LinkInvalidatedReason } from "../src/shared/types";

// 链接作废（阶段3 断链善后）的行为测试。
//
// 这一步以前只是「代码里看起来对」：隧道路径在 CI 里摸不到，DB 迁移也漏过一次，
// 结果 markLinksInvalidated 直接 no such column、B 拿 404、A 什么也看不到。
// 所以这里不碰隧道管理器，只验「已经打完作废标记之后，各端应该怎么看」。

let token: string | null = null;

async function local(url: string, init?: RequestInit) {
  const t = token ?? "phase3-link-test-token";
  const app = createLocalApp();
  return app.fetch(
    new Request(
      `http://127.0.0.1:${config.localPort}${url}`,
      withLocalHeaders(init, t),
    ),
  );
}

function withLocalHeaders(
  init: RequestInit | undefined,
  t: string,
): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set("Host", `127.0.0.1:${config.localPort}`);
  headers.set("Origin", `http://127.0.0.1:${config.localPort}`);
  if (!headers.has("Cookie"))
    headers.set("Cookie", `${CONTROL_COOKIE_NAME}=${t}`);
  return { ...init, headers };
}

async function publicReq(url: string, init?: RequestInit) {
  const app = createPublicApp();
  const headers = new Headers(init?.headers);
  headers.set("Host", `127.0.0.1:${config.publicPort}`);
  return app.fetch(
    new Request(`http://127.0.0.1:${config.publicPort}${url}`, {
      ...init,
      headers,
    }),
  );
}

async function bootstrap(): Promise<string> {
  // 开发令牌走 LOCAL_CONTROL_TOKEN_SECRET（test/setup.ts 已设），A 端 Cookie 就是它。
  token = getControlToken();
  __resetBootstrapConsumedForTests();
  return token;
}

async function newClaimedSession(): Promise<{ id: string; cookie: string }> {
  const createRes = await local("/api/local/sessions", {
    method: "POST",
    body: "{}",
  });
  expect(createRes.status).toBe(201);
  const created = await createRes.json();
  const id = created.session.id as string;
  const res = await publicReq(`/api/public/sessions/${id}/claim`, {
    method: "POST",
  });
  expect(res.status).toBe(200);
  const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
  expect(cookie.length).toBeGreaterThan(0);
  return { id, cookie };
}

async function seedChat(id: string, cookie: string): Promise<void> {
  await publicReq(`/api/public/sessions/${id}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      "Idempotency-Key": "link-b-1",
    },
    body: JSON.stringify({ body: "你会不会写诗" }),
  });
  await local(`/api/local/sessions/${id}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": "link-a-1",
    },
    body: JSON.stringify({ body: "略懂" }),
  });
}

afterEach(() => {
  token = null;
  __resetBootstrapConsumedForTests();
  const db = getDb();
  db.prepare(`DELETE FROM rounds`).run();
  db.prepare(`DELETE FROM claims`).run();
  db.prepare(`DELETE FROM idempotency_keys`).run();
  db.prepare(`DELETE FROM sessions`).run();
});

describe("链接作废后的各端口径", () => {
  it("作废标记会写进会话行，A 看得见原因", async () => {
    await bootstrap();
    const { id, cookie } = await newClaimedSession();
    await seedChat(id, cookie);

    expect(
      markLinksInvalidated("TUNNEL_DOWN" satisfies LinkInvalidatedReason),
    ).toBe(1);

    // 墓碑行留在库里：这是 B 能拿到 410（而不是 404）的依据
    const row = getDb()
      .prepare(
        `SELECT state, link_invalidated_at, link_invalidated_reason FROM sessions WHERE id = ?`,
      )
      .get(id) as {
      state: string;
      link_invalidated_at: string | null;
      link_invalidated_reason: string | null;
    };
    expect(row.state).toBe("CLOSED");
    expect(row.link_invalidated_at).toBeTruthy();
    expect(row.link_invalidated_reason).toBe("TUNNEL_DOWN");
    // 正文不能留在内存里：链接作废等于这轮结束了
    expect(memoryStore.getMessages(id)).toEqual([]);
    expect(memoryStore.listPending(id)).toEqual([]);
    // A 侧：不再算「进行中」（首页列表里消失），但直接访问详情仍能读到作废原因 ——
    // 这正是留墓碑的意义：A 的会话页要说得出「链接已作废」，而不是凭空 404。
    expect(
      new SessionRepository(getDb()).listLive().map((r) => r.id),
    ).not.toContain(id);
    const detail = await (await local(`/api/local/sessions/${id}`)).json();
    expect(detail.session.linkInvalidatedAt).toBeTruthy();
    expect(detail.session.linkInvalidatedReason).toBe("TUNNEL_DOWN");
    expect(detail.messages).toEqual([]);
  });

  it("B 的四个公开端点都返回 410 LINK_INVALIDATED", async () => {
    await bootstrap();
    const { id, cookie } = await newClaimedSession();
    await seedChat(id, cookie);
    markLinksInvalidated("TUNNEL_URL_CHANGED");

    const paths: Array<[string, RequestInit]> = [
      [`/api/public/sessions/${id}`, { headers: { cookie } }],
      [`/api/public/sessions/${id}/poll`, { headers: { cookie } }],
      [`/api/public/sessions/${id}/preview`, {}],
      [`/api/public/sessions/${id}/claim`, { method: "POST" }],
      [
        `/api/public/sessions/${id}/messages`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie,
            "Idempotency-Key": "link-b-2",
          },
          body: JSON.stringify({ body: "还在吗" }),
        },
      ],
    ];
    for (const [path, init] of paths) {
      const res = await publicReq(path, init);
      expect({ path, status: res.status }).toEqual({ path, status: 410 });
      const body = await res.json();
      expect(body.error).toBe("LINK_INVALIDATED");
    }
  });

  it("重复作废是 no-op，不会覆盖第一次的原因", async () => {
    await bootstrap();
    const { id } = await newClaimedSession();
    const firstAt = markLinksInvalidated("TUNNEL_DOWN");
    expect(firstAt).toBe(1);
    const readRow = () =>
      getDb()
        .prepare(
          `SELECT link_invalidated_at AS at, link_invalidated_reason AS reason FROM sessions WHERE id = ?`,
        )
        .get(id) as {
        at: string;
        reason: string;
      };
    const first = readRow();

    expect(markLinksInvalidated("TUNNEL_STOPPED")).toBe(0);
    expect(readRow()).toEqual(first);
    expect(first.reason).toBe("TUNNEL_DOWN");
  });

  it("没公网链接时的硬清理仍然删行（本机开发不该被作废标记缠住）", async () => {
    await bootstrap();
    const { id, cookie } = await newClaimedSession();
    await seedChat(id, cookie);

    expect(closeAllSessions()).toBe(1);
    expect(
      getDb()
        .prepare(`SELECT COUNT(*) AS n FROM sessions WHERE id = ?`)
        .get(id),
    ).toEqual({ n: 0 });
    const missing = await local(`/api/local/sessions/${id}`);
    expect(missing.status).toBe(404);
    const gone = await publicReq(`/api/public/sessions/${id}/poll`, {
      headers: { cookie },
    });
    expect(gone.status).toBe(404);
  });

  it("作废留下的会话行也会被 10 小时过期回收", async () => {
    await bootstrap();
    const { id } = await newClaimedSession();
    markLinksInvalidated("TUNNEL_DOWN");
    const db = getDb();
    const row = db
      .prepare(`SELECT created_at FROM sessions WHERE id = ?`)
      .get(id) as { created_at: string };
    const elevenHoursAgo = new Date(
      Date.parse(row.created_at) - 11 * 3600_000,
    ).toISOString();
    db.prepare(`UPDATE sessions SET created_at = ? WHERE id = ?`).run(
      elevenHoursAgo,
      id,
    );

    // 维护器的过期扫描要能把已作废的行一起收掉，否则库里会越积越多墓碑
    await local(`/api/local/sessions/${id}/close`, { method: "POST" });
    const left = db
      .prepare(`SELECT COUNT(*) AS n FROM sessions WHERE id = ?`)
      .get(id) as { n: number };
    expect(left.n).toBe(0);
    expect(memoryStore.getMessages(id)).toEqual([]);
  });
});

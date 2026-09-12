import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalApp } from "../src/server/local-server.js";
import { createPublicApp } from "../src/server/public-server.js";
import {
  CONTROL_COOKIE_NAME,
  __resetBootstrapConsumedForTests,
  getControlToken,
} from "../src/server/security/control-token.js";
import { CLAIM_COOKIE_NAME } from "../src/server/routes/public/sessions.js";
import type {
  AReplyResponse,
  ClaimResponse,
  CreateSessionResponse,
  PublicSessionResponse,
  SessionDetailResponse,
} from "../src/shared/types.js";

// 全链路集成测试（开发文档待办项）：
// 创建会话(A) -> B 发消息 -> A 侧看到 pending -> A 回复 -> B 通过 poll 收到回复。
//
// 说明：这里直接通过 app.request() 走真实路由栈（含 localAuth/whitelist 中间件），
// 复用 local-auth-bootstrap.test.ts 里验证过的 Host+Origin+Cookie 三重校验流程来换取 Cookie。
// getDb()/memoryStore 是模块级单例（真实文件型 SQLite + 内存 Map），但 SessionRepository.create()
// 使用 randomUUID() 生成会话 id，不同测试之间不会产生逻辑冲突，因此无需额外隔离。

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

async function bootstrapCookie(
  localApp: ReturnType<typeof createLocalApp>,
): Promise<string> {
  const token = getControlToken();
  const res = await localApp.request(`/api/local/bootstrap/${token}`, {
    method: "POST",
    headers: { host: "127.0.0.1:8787", origin: LOCAL_ORIGIN },
  });
  expect(res.status).toBe(200);
  const cookieValue = extractCookieValue(
    res.headers.get("set-cookie"),
    CONTROL_COOKIE_NAME,
  );
  expect(cookieValue).not.toBeNull();
  return cookieValue as string;
}

// 阶段2 缺口1：B 侧访问受 claim 凭证保护的路由前，必须先绑定（claim）拿到凭证 Cookie，
// 否则会被"不可区分404"规则挡掉（与会话不存在时返回同样的 404，不额外暴露403）。
async function claimCookie(
  publicApp: ReturnType<typeof createPublicApp>,
  sessionId: string,
): Promise<string> {
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
  const cookieValue = extractCookieValue(
    res.headers.get("set-cookie"),
    CLAIM_COOKIE_NAME,
  );
  expect(cookieValue).not.toBeNull();
  return cookieValue as string;
}

describe("full-chain integration: create -> B sends -> A sees pending -> A replies -> B polls", () => {
  beforeEach(() => {
    __resetBootstrapConsumedForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks(); // 否则被接走的 console 输出会影响其它测试
  });

  it("carries a message end to end through both entrances", async () => {
    // 把控制台输出接走，结束时检查日志底线（logger 最终也是写 console）
    const logged: string[] = [];
    for (const level of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });
    }

    const localApp = createLocalApp();
    const publicApp = createPublicApp();
    const cookie = await bootstrapCookie(localApp);
    const localHeaders = {
      host: "127.0.0.1:8787",
      origin: LOCAL_ORIGIN,
      cookie: `${CONTROL_COOKIE_NAME}=${cookie}`,
    };

    // 1. A 创建会话
    const createRes = await localApp.request("/api/local/sessions", {
      method: "POST",
      headers: localHeaders,
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as CreateSessionResponse;
    expect(created.session.state).toBe("WAITING");
    const sessionId = created.session.id;

    // 1.5 B 绑定（claim）：一条链接只能被一个B设备绑定，绑定后才能访问该会话的公开路由。
    const bClaim = await claimCookie(publicApp, sessionId);
    const publicHeaders = {
      host: "127.0.0.1:8788",
      origin: PUBLIC_ORIGIN,
      cookie: `${CLAIM_COOKIE_NAME}=${bClaim}`,
    };

    // 2. B 发消息（携带 Idempotency-Key）
    const bMessageRes = await publicApp.request(
      `/api/public/sessions/${sessionId}/messages`,
      {
        method: "POST",
        headers: {
          ...publicHeaders,
          "content-type": "application/json",
          "idempotency-key": "b-msg-1",
        },
        body: JSON.stringify({ body: "hello from B" }),
      },
    );
    expect(bMessageRes.status).toBe(201);
    const bMessageBody = (await bMessageRes.json()) as {
      message: { id: string };
    };
    const bMessageId = bMessageBody.message.id;

    // 3. A 侧应看到 WAITING -> ACTIVE，以及一条 WAITING_A 的 pending 项
    const aViewRes = await localApp.request(
      `/api/local/sessions/${sessionId}`,
      {
        headers: localHeaders,
      },
    );
    expect(aViewRes.status).toBe(200);
    const aView = (await aViewRes.json()) as SessionDetailResponse;
    expect(aView.session.state).toBe("ACTIVE");
    expect(aView.messages).toHaveLength(1);
    expect(aView.messages[0]?.sender).toBe("B");
    expect(aView.messages[0]?.body).toBe("hello from B");
    expect(aView.pending).toHaveLength(1);
    expect(aView.pending[0]?.state).toBe("WAITING_A");
    // 阶段2 缺口2：B 单独发送不计轮次（PRD §5.2）
    expect(aView.roundCount).toBe(0);

    // 4. A 回复（携带 Idempotency-Key：网络重试不得产生重复轮次，PRD §10）
    const aReplyRes = await localApp.request(
      `/api/local/sessions/${sessionId}/messages`,
      {
        method: "POST",
        headers: {
          ...localHeaders,
          "content-type": "application/json",
          "idempotency-key": "a-reply-1",
        },
        body: JSON.stringify({ body: "hi from A" }),
      },
    );
    expect(aReplyRes.status).toBe(201);
    const aReplyBody = (await aReplyRes.json()) as AReplyResponse;
    expect(aReplyBody.countedRound).toBe(true);
    expect(aReplyBody.roundCount).toBe(1);

    // 同一个 key 重放：返回同一份缓存结果，不追加消息、不重复计轮次
    const aReplyReplay = await localApp.request(
      `/api/local/sessions/${sessionId}/messages`,
      {
        method: "POST",
        headers: {
          ...localHeaders,
          "content-type": "application/json",
          "idempotency-key": "a-reply-1",
        },
        body: JSON.stringify({ body: "hi from A" }),
      },
    );
    expect(aReplyReplay.status).toBe(201);
    expect((await aReplyReplay.json()) as AReplyResponse).toEqual(aReplyBody);

    // pending 项应已流转到 DELIVERED
    const aViewAfterReply = await localApp.request(
      `/api/local/sessions/${sessionId}`,
      {
        headers: localHeaders,
      },
    );
    const aViewAfterReplyBody =
      (await aViewAfterReply.json()) as SessionDetailResponse;
    expect(aViewAfterReplyBody.pending).toHaveLength(1);
    expect(aViewAfterReplyBody.pending[0]?.state).toBe("DELIVERED");
    // 重放没有抬高轮次，A 消息也只有一条
    expect(aViewAfterReplyBody.roundCount).toBe(1);
    expect(
      aViewAfterReplyBody.messages.filter((m) => m.sender === "A"),
    ).toHaveLength(1);

    // 5. B 通过 poll 收到 A 的回复（不泄露 A 侧信息，只有 messages）
    const pollRes = await publicApp.request(
      `/api/public/sessions/${sessionId}/poll?after=${bMessageId}`,
      { headers: publicHeaders },
    );
    expect(pollRes.status).toBe(200);
    const pollBody = (await pollRes.json()) as {
      messages: { sender: string; body: string }[];
    };
    expect(pollBody.messages).toHaveLength(1);
    expect(pollBody.messages[0]?.sender).toBe("A");
    expect(pollBody.messages[0]?.body).toBe("hi from A");

    // B 视角的会话详情不应包含任何 A 专属字段（如 pending）
    const bViewRes = await publicApp.request(
      `/api/public/sessions/${sessionId}`,
      {
        headers: publicHeaders,
      },
    );
    const bView = (await bViewRes.json()) as PublicSessionResponse;
    expect(bView).not.toHaveProperty("pending");
    expect(bView.messages).toHaveLength(2);

    // PRD §18.6 日志底线：跑完全流程后，任何一行输出都不该出现会话 id、控制令牌、B 绑定凭证。
    // （服务端日志走 logger 的字段白名单；这里兜住的是有人绕过 logger 直接 console.log 的情况。
    //  消息正文 "hello from B" 故意不入黑名单：B 自己发的内容会出现在 B 路由的调试输出里不算违规，
    //  真正不能出现的是标识符和凭证。）
    const logs = logged.join("\n");
    expect(logs).not.toContain(sessionId);
    expect(logs).not.toContain(cookie);
    expect(logs).not.toContain(bClaim);
    expect(logs.length).toBeGreaterThan(0); // 确认真接到了输出，别变成一个永远为真的断言
  });
});

// ---------- 用户要求：「A 发了链接、B 到没到」必须能从日志里查出来 ----------
describe("链接的可追溯日志（created / opened，且不泄露完整会话 id）", () => {
  beforeEach(() => {
    __resetBootstrapConsumedForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** 把 logger 最终写出去的 console 输出收回来，解析成结构化行。 */
  function captureLogs(): string[] {
    const logged: string[] = [];
    for (const level of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });
    }
    return logged;
  }

  it("新建窗口留一行 link created，带上来源与隧道状态", async () => {
    const logged = captureLogs();
    const localApp = createLocalApp();
    const cookie = await bootstrapCookie(localApp);
    const res = await localApp.request("/api/local/sessions", {
      method: "POST",
      headers: {
        host: "127.0.0.1:8787",
        origin: LOCAL_ORIGIN,
        cookie: `${CONTROL_COOKIE_NAME}=${cookie}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateSessionResponse;

    const line = logged
      .map((x) => {
        try {
          return JSON.parse(x) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .find((d) => d?.msg === "link created");
    expect(line).toBeTruthy();
    expect(line!.linkEvent).toBe("created");
    // 这台机器上没跑真隧道时也必须有来源可看（local-dev 就是要让人一眼看出来）
    expect(["tunnel", "config", "local-dev"]).toContain(line!.linkSource as string);
    // 拿不到公网基址时必须分清「隧道没地址」和「有地址但本机没验通」，否则日志上两种故障长一个样
    if (line!.linkSource === "local-dev") {
      expect(["none", "pending"]).toContain(line!.linkAddr as string);
    } else {
      expect(line!.linkAddr).toBeUndefined();
    }
    expect(line!.tunnelStatus).toBeTruthy();
    expect(String(line!.linkRef)).toMatch(/^[0-9a-f]{8}$/);
    expect(String(line!.linkRef)).toBe(body.session.id.slice(0, 8));
  });

  it("B 打开页面留一行 link opened，ref 能和 created 对上；完整 id 绝不进日志", async () => {
    const logged = captureLogs();
    const localApp = createLocalApp();
    const publicApp = createPublicApp();
    const cookie = await bootstrapCookie(localApp);
    const created = (await (
      await localApp.request("/api/local/sessions", {
        method: "POST",
        headers: {
          host: "127.0.0.1:8787",
          origin: LOCAL_ORIGIN,
          cookie: `${CONTROL_COOKIE_NAME}=${cookie}`,
          "content-type": "application/json",
        },
        body: "{}",
      })
    ).json()) as CreateSessionResponse;
    const id = created.session.id;

    const page = await publicApp.request(`/s/${id}`, {
      headers: { host: "127.0.0.1:8788" },
    });
    expect(page.status).toBe(200);

    const json = logged
      .map((x) => {
        try {
          return JSON.parse(x) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const createdRow = json.find((d) => d!.msg === "link created");
    const openedRow = json.find((d) => d!.msg === "link opened");
    expect(openedRow).toBeTruthy();
    // 两行靠同一个 8 位前缀对上 —— 这就是「A 说发了、B 说到没到」的全部依据
    expect(openedRow!.linkRef).toBe(createdRow!.linkRef);
    expect(openedRow!.linkEvent).toBe("opened");

    // 底线：日志里没有完整会话 UUID，也没有 /s/<完整id> 这种可点开的形状
    const blob = JSON.stringify(json);
    expect(blob).not.toContain(id);
    expect(blob).not.toContain(`/s/${id}`);
  });

  it("同一条链接反复刷新只记一次「到达」，不同链接各记一次", async () => {
    const logged = captureLogs();
    const localApp = createLocalApp();
    const publicApp = createPublicApp();
    const cookie = await bootstrapCookie(localApp);
    const headers = {
      host: "127.0.0.1:8787",
      origin: LOCAL_ORIGIN,
      cookie: `${CONTROL_COOKIE_NAME}=${cookie}`,
      "content-type": "application/json",
    };
    const a = (await (
      await localApp.request("/api/local/sessions", { method: "POST", headers, body: "{}" })
    ).json()) as CreateSessionResponse;
    const b = (await (
      await localApp.request("/api/local/sessions", { method: "POST", headers, body: "{}" })
    ).json()) as CreateSessionResponse;

    const count = () =>
      logged.filter((x) => x.includes('"link opened"')).length;
    await publicApp.request(`/s/${a.session.id}`, { headers: { host: "127.0.0.1:8788" } });
    await publicApp.request(`/s/${a.session.id}`, { headers: { host: "127.0.0.1:8788" } });
    await publicApp.request(`/s/${a.session.id}`, { headers: { host: "127.0.0.1:8788" } });
    expect(count()).toBe(1); // 刷新不刷日志
    await publicApp.request(`/s/${b.session.id}`, { headers: { host: "127.0.0.1:8788" } });
    expect(count()).toBe(2); // 换一条链接要能看出来
  });
});

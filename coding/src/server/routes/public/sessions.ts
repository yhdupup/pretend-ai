import { Hono, type Context } from "hono";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { setCookie, getCookie } from "hono/cookie";
import { getDb } from "../../db/index.js";
import {
  SessionRepository,
  SessionNotFoundError,
  LinkAlreadyClaimedError,
  type SessionRow,
} from "../../session/repository.js";
import { memoryStore } from "../../session/memory-store.js";
import { toPublicMessage, toRevealInfo } from "../../session/mapper.js";
import {
  IdempotencyStore,
  IdempotencyConflictError,
  hashContent,
} from "../../session/idempotency.js";
import { config } from "../../config.js";
import { maskBlockedContent } from "../../security/content-filter.js";
import { sanitizeAvatarData } from "../../../shared/avatars.js";
import type {
  ClaimResponse,
  PollResponse,
  PreviewResponse,
  PublicSessionResponse,
} from "../../../shared/types.js";

// B 入口（局域网/隧道可达，8788）会话相关接口。开发文档 §七。
// 注意：B 侧任何响应都不能泄露 A 侧信息（Cookie/Authorization/模型凭证等），
// 且未揭示（HIDDEN）时不能让 B 察觉对方是"假的"。

const app = new Hono();

// 阶段2 缺口1：单B绑定凭证 Cookie。Secure + SameSite=Lax（而非 Strict）：
// B 端场景是跨设备/局域网访问被绑定的公开会话链接，非本机场景，Strict 会阻断跨站导航携带 Cookie。
export const CLAIM_COOKIE_NAME = "aiwindow_claim";

// 校验请求携带的凭证 Cookie 是否与 claims 表记录一致。未绑定或哈希不匹配都视为无效，
// 路由层统一返回 404（与会话不存在时的"不可区分404"原则一致，不额外暴露403而泄露"存在但未绑定"的信号）。
function verifyClaim(
  repo: SessionRepository,
  id: string,
  cookieValue: string | undefined,
): boolean {
  if (!cookieValue) return false;
  const claim = repo.findClaim(id);
  if (!claim) return false;
  return hashContent(cookieValue) === claim.credential_hash;
}

const messageBodySchema = z.object({
  body: z.string().min(1).max(4000),
});

/** 阶段4：这个会话已经有一条没回答完的问题（B 侧 409 MESSAGE_PENDING）。 */
class MessagePendingError extends Error {}

// 阶段3：链接作废 → 410，而不是「查无此链接」的 404。
// 拿到过这个链接的人是会话的另一方，他有权知道「刚才那个对话已经因为公网中断结束了」；
// 而探测者本来就进不到这一步（他连会话 id 都没有），所以这里放宽不增加可枚举面。
// 判断必须放在每一个公开端点取到会话行之后：只在一处判断的话，
// 作废后某个接口仍会照常返回 200，会话就变成半死不活。
function linkInvalidated(c: Context, row: SessionRow): Response | null {
  return row.link_invalidated_at
    ? c.json({ error: "LINK_INVALIDATED" }, 410)
    : null;
}

app.post("/:id/claim", (c) => {
  const id = c.req.param("id");
  const repo = new SessionRepository(getDb());
  let claimedRow: SessionRow;
  try {
    claimedRow = repo.requireById(id);
  } catch (err) {
    if (err instanceof SessionNotFoundError) return c.notFound();
    throw err;
  }
  const gone = linkInvalidated(c, claimedRow);
  if (gone) return gone;

  const credential = randomBytes(32).toString("hex");
  try {
    repo.claim(id, hashContent(credential));
  } catch (err) {
    if (err instanceof LinkAlreadyClaimedError) {
      return c.json({ error: "LINK_ALREADY_CLAIMED" }, 409);
    }
    throw err;
  }

  setCookie(c, CLAIM_COOKIE_NAME, credential, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
  });

  const response: ClaimResponse = { ok: true };
  return c.json(response);
});

// 绑定前的预览（PRD §17.2 preview）：不需要 Cookie、不产生绑定，只返回虚构 AI 的人设与开场白。
// 没有这个路由时，B 页面首屏必须先把链接 claim 掉才能拿到任何内容，会提前绑死名额。
app.get("/:id/preview", (c) => {
  const id = c.req.param("id");
  const repo = new SessionRepository(getDb());
  const row = repo.findById(id);
  if (!row) return c.notFound();
  // 预览也要挡：不然新设备点开一个作废链接会看到「开始对话」，点了才发现什么都没有了
  const gone = linkInvalidated(c, row);
  if (gone) return gone;
  const response: PreviewResponse = {
    aiName: maskBlockedContent(row.ai_name ?? "").text,
    avatarId: row.avatar_id ?? "",
    // 默认头像是一张打包进去的静态图，这里只可能带 A 自己上传的那张（图片不含文字，无需过屏蔽词）。
    avatarData: sanitizeAvatarData(row.ai_avatar_data),
    openingMessage: maskBlockedContent(row.opening_message ?? "").text,
    state: row.state,
    roundLimit: config.roundLimit,
    timeLimitMinutes: config.timeLimitMinutes,
  };
  return c.json(response);
});

app.get("/:id", (c) => {
  const id = c.req.param("id");
  const repo = new SessionRepository(getDb());
  try {
    const row = repo.requireById(id);
    const gone = linkInvalidated(c, row);
    if (gone) return gone;
    if (!verifyClaim(repo, id, getCookie(c, CLAIM_COOKIE_NAME)))
      return c.notFound();
    const response: PublicSessionResponse = {
      session: {
        id: row.id,
        state: row.state,
        revealState: row.reveal_state,
        revealedAt: row.revealed_at,
      },
      aiName: maskBlockedContent(row.ai_name ?? "").text,
      avatarId: row.avatar_id ?? "",
      avatarData: sanitizeAvatarData(row.ai_avatar_data),
      openingMessage: maskBlockedContent(row.opening_message ?? "").text,
      reveal: toRevealInfo(row),
      messages: memoryStore.getMessages(id).map(toPublicMessage),
      roundLimit: config.roundLimit,
      timeLimitMinutes: config.timeLimitMinutes,
    };
    return c.json(response);
  } catch (err) {
    if (err instanceof SessionNotFoundError) return c.notFound();
    throw err;
  }
});

app.post("/:id/messages", async (c) => {
  const id = c.req.param("id");
  const repo = new SessionRepository(getDb());

  try {
    const gone = linkInvalidated(c, repo.requireById(id));
    if (gone) return gone;
  } catch (err) {
    if (err instanceof SessionNotFoundError) return c.notFound();
    throw err;
  }

  if (!verifyClaim(repo, id, getCookie(c, CLAIM_COOKIE_NAME)))
    return c.notFound();

  const idempotencyKey = c.req.header("Idempotency-Key");
  if (!idempotencyKey) {
    return c.json({ error: "IDEMPOTENCY_KEY_REQUIRED" }, 400);
  }

  const rawBody = await c.req.text();
  const parsedJson = (() => {
    try {
      return JSON.parse(rawBody);
    } catch {
      return null;
    }
  })();
  const parsed = messageBodySchema.safeParse(parsedJson);
  if (!parsed.success) {
    return c.json({ error: "INVALID_BODY" }, 400);
  }

  const row = repo.requireById(id);
  // WAITING -> ACTIVE：B 首次发消息也视为会话进入活跃状态。
  if (row.state === "WAITING") {
    repo.transitionState(id, "ACTIVE");
  }

  const idempotency = new IdempotencyStore(getDb());
  try {
    const result = idempotency.resolve(idempotencyKey, id, rawBody, () => {
      // 单轮单问题（PRD §5.1 §7.4）：上一条还没被 A 回答，B 就不能再压一条进来。
      // 阶段1/2/3 都漏了这道锁，阶段4 补上 —— 没有它，§9.3「有且只有一条待回复问题」
      // 这个前提根本不成立，「处理草稿」到底在处理哪一句都会变歧义。
      // 抛错而不是提前 return：让幂等重放走缓存分支，网络重试不会被自己的锁挡成 409。
      if (memoryStore.oldestWaiting(id)) throw new MessagePendingError();

      const message = memoryStore.appendMessage(id, "B", parsed.data.body);
      memoryStore.createPending(id, parsed.data.body);
      return { message };
    });
    return c.json(result, 201);
  } catch (err) {
    if (err instanceof IdempotencyConflictError) {
      return c.json({ error: "IDEMPOTENCY_CONFLICT" }, 409);
    }
    if (err instanceof MessagePendingError) {
      // 文案要像聊天产品，不像错误码：B 不需要知道“pending”这种内部词（§8.3）。
      return c.json(
        { error: "MESSAGE_PENDING", message: "对方正在输入，先等一下" },
        409,
      );
    }
    throw err;
  }
});

// B 轮询。除了新消息，还带回会话状态 / 已完成轮数 / 揭晓信息：
// PRD §5.3 要求时间与 A 主动触发的揭晓“在下一次轮询后自动弹窗”，所以轮询响应必须携带揭晓状态。
app.get("/:id/poll", (c) => {
  const id = c.req.param("id");
  const repo = new SessionRepository(getDb());
  let row;
  try {
    row = repo.requireById(id);
  } catch (err) {
    if (err instanceof SessionNotFoundError) return c.notFound();
    throw err;
  }
  const gone = linkInvalidated(c, row);
  if (gone) return gone;
  if (!verifyClaim(repo, id, getCookie(c, CLAIM_COOKIE_NAME)))
    return c.notFound();

  const after = c.req.query("after") ?? undefined;
  const messages = memoryStore.getMessagesAfter(id, after).map(toPublicMessage);
  const response: PollResponse = {
    messages,
    session: {
      id: row.id,
      state: row.state,
      revealState: row.reveal_state,
      revealedAt: row.revealed_at,
    },
    completedRounds: repo.countRounds(id),
    roundLimit: config.roundLimit,
    reveal: toRevealInfo(row),
  };
  return c.json(response);
});

export default app;

import { Hono } from "hono";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { getDb } from "../../db/index.js";
import {
  SessionRepository,
  SessionNotFoundError,
  type SessionRow,
} from "../../session/repository.js";
import { InvalidTransitionError } from "../../session/state-machine.js";
import { memoryStore } from "../../session/memory-store.js";
import { toSessionSummary } from "../../session/mapper.js";
import {
  IdempotencyStore,
  IdempotencyConflictError,
} from "../../session/idempotency.js";
import { SettingsRepository } from "../../settings/repository.js";
import { runAssist, type AssistFailure } from "../../../assist/orchestrator.js";
import { getSkillRegistry } from "../../../assist/skills/loader.js";
import { checkManualAnalysis, hashText } from "../../../assist/validate.js";
import { getCredentials } from "../../../model/credentials.js";
import { AVATAR_IDS, MAX_AVATAR_DATA_CHARS } from "../../../shared/avatars.js";
import { config } from "../../config.js";
import { logger } from "../../logger.js";
import { maskBlockedContent } from "../../security/content-filter.js";
import { getTunnelManager } from "../../tunnel/index.js";
import type {
  AReplyResponse,
  CreateSessionResponse,
  HeartbeatResponse,
  MessageAssistMeta,
  ProcessResponse,
  SessionDetailResponse,
} from "../../../shared/types.js";

// A 入口（本机专用，127.0.0.1:8787）会话相关接口。开发文档 §七。

const app = new Hono();

// 阶段4 新增两个可选字段：只用于「这条回复配的那段可分析过程」的一致性校验。
// analysisSummary **不由前端传**：正文哈希对上后由服务端从生成记录里取，防止 A 页面被改出任意摘要。
const messageBodySchema = z.object({
  body: z.string().min(1).max(4000),
  processId: z.string().min(1).max(100).optional(),
});

// 创建窗口字段（PRD §7.1 §7.3）：AI 名称、内置头像、开场白、揭晓留言。
// 全部可选：不带的字段由 SettingsRepository 用「我的设置」里的默认值补齐，
// 这样 `curl -d '{}'` 冒烟测试和阶段1 既有调用方还能照常工作；带了就必须合法（头像乱填照样 400）。
const createBodySchema = z.object({
  aiName: z.string().min(1).max(40).optional(),
  avatarId: z.enum(AVATAR_IDS).optional(),
  // 上限跟 sanitizeAvatarData 同一条：超长直接在门口拒掉，不必先把整串读进内存再丢。
  avatarData: z.string().max(MAX_AVATAR_DATA_CHARS).optional(),
  openingMessage: z.string().min(1).max(500).optional(),
  revealMessage: z.string().min(1).max(300).optional(),
});

const DEFAULT_CREATE = {
  aiName: "小雷 AI",
  avatarId: "robot-01" as const,
  openingMessage: "你好，我是小雷 AI，有什么想问的？",
};

app.post("/", async (c) => {
  const raw = await c.req.text();
  let input: z.infer<typeof createBodySchema> = DEFAULT_CREATE;
  if (raw.trim()) {
    let json: unknown = null;
    try {
      json = JSON.parse(raw);
    } catch {
      return c.json({ error: "INVALID_BODY" }, 400);
    }
    const parsed = createBodySchema.safeParse(json);
    if (!parsed.success) return c.json({ error: "INVALID_BODY" }, 400);
    input = parsed.data;
  }

  const db = getDb();
  const settings = new SettingsRepository(db);
  const repo = new SessionRepository(db);
  // 缺省字段退回 DEFAULT_CREATE：只传一部分（例如只改 aiName）也能建，剩下的走默认。
  const row = repo.create(
    settings.snapshotForSession({ ...DEFAULT_CREATE, ...input }),
  );
  const publicPath = `/s/${row.id}`;
  // 链接基址三档：本次隧道拿到的公网域名 → 配置里写死的公网基址 → 本机地址（只能自己电脑上点）。
  const tunnel = getTunnelManager();
  const link = tunnel.baseUrlForLink();
  const snap = tunnel.snapshot();
  // 这条日志就是用户问「我刚发的链接别人能打开吗」时唯一的事实回答。
  // 尤其 local-dev 这一档必须留痕：它的意思是「链接发出去了，但别人注定打不开」，
  // 修前这个分岔完全静默，A 只会拿着一个 127.0.0.1 的地址去发给朋友。
  logger.info("link created", {
    linkEvent: "created",
    linkSource: link ? link.source : "local-dev",
    // 拿不到公网基址时，还要分清「逆道没地址」和「有地址但本机没验通」：前者再等几秒，后者得查代理。
    ...(!link
      ? { linkAddr: snap.pendingBaseUrl ? ("pending" as const) : ("none" as const) }
      : {}),
    linkRef: row.id.slice(0, 8),
    tunnelStatus: snap.status,
  });
  const response: CreateSessionResponse = {
    session: toSessionSummary(row),
    publicPath,
    publicUrl: link
      ? `${link.base}${publicPath}`
      : `http://127.0.0.1:${config.publicPort}${publicPath}`,
    publicUrlSource: link ? link.source : "local-dev",
  };
  return c.json(response, 201);
});

app.get("/:id", (c) => {
  const id = c.req.param("id");
  const repo = new SessionRepository(getDb());
  try {
    const row = repo.requireById(id);
    const response: SessionDetailResponse = {
      session: toSessionSummary(row),
      pending: memoryStore.listPending(id),
      messages: memoryStore.getMessages(id),
      roundCount: repo.countRounds(id),
      roundLimit: config.roundLimit,
      // 倒计时用服务端时间做差，不接受前端本地时钟（PRD §16.6）
      serverTime: new Date().toISOString(),
      // 阶段4（§9.3 条件5）：有任务在飞时 A 页面把「处理草稿」置灰，不做排队。
      generating: memoryStore.isGenerating(id),
    };
    return c.json(response);
  } catch (err) {
    if (err instanceof SessionNotFoundError) return c.notFound();
    throw err;
  }
});

// ---------- 阶段4：处理草稿（PRD §6.6 §9.3）----------

/** 一致性不通过：正文被改过，或者生成结果已经过期（§6.6「A 改过正文就要重新确认摘要」）。 */
class AnalysisStaleError extends Error {}
const processSchema = z.object({
  draft: z.string().min(1).max(4000),
  aiStyleEnabled: z.boolean(),
  analysisEnabled: z.boolean(),
  styleLevel: z.enum(["轻微", "明显", "浓郁"]).optional(),
  mode: z.enum(["manual", "rules", "user_model"]).optional(),
  analysisManual: z.string().max(2000).optional(),
});

const confirmSchema = z.object({
  // A 改过正文后要显式带上新正文（服务端把 replyHash 前移，等价于「我确认这条摘要还配得上这段话」）。
  reply: z.string().max(4000).optional(),
  analysisSummary: z.string().max(4000).optional(),
});

const PROCESS_HTTP: Record<AssistFailure["code"], 400 | 409 | 422 | 429> = {
  DRAFT_EMPTY: 400,
  SKILL_MISSING: 409,
  MODEL_NOT_CONFIGURED: 409,
  MODEL_CONFIG_INVALID: 409,
  MODEL_UNAVAILABLE: 409,
  // 预算不够不是「点太快」，也不是服务端拦下：单独一个码才能给人话原因。
  MODEL_OUTPUT_TRUNCATED: 409,
  RATE_LIMITED: 429,
  INVALID_MODEL_OUTPUT: 422,
};

app.post("/:id/process", async (c) => {
  const id = c.req.param("id");
  const db = getDb();
  const repo = new SessionRepository(db);
  const settings = new SettingsRepository(db);

  let row: SessionRow;
  try {
    row = repo.requireById(id);
  } catch (err) {
    if (err instanceof SessionNotFoundError) return c.notFound();
    throw err;
  }
  // 链接已作废的会话：正文再加工也没人能收到，让 A 先去开新链接（阶段3 §链接作废）。
  if (row.link_invalidated_at)
    return c.json({ error: "LINK_INVALIDATED" }, 410);

  const parsed = processSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "INVALID_BODY" }, 400);

  const pending = memoryStore.oldestWaiting(id);
  // §9.3 条件 1/3/4：有一条“还没回答”的 B 问题，取它的问题正文（不取 A 传的问题，防前端伪造上下文）。
  if (!pending)
    return c.json(
      { error: "NO_PENDING_MESSAGE", message: "现在没有等你回答的问题" },
      409,
    );

  const assist = settings.assist();
  const mode = parsed.data.mode ?? assist.mode;
  if (mode === "manual") {
    return c.json(
      { error: "MANUAL_MODE", message: "当前是人工模式，处理草稿按钮不该出现" },
      409,
    );
  }
  if (mode === "user_model" && !getCredentials()) {
    return c.json(
      {
        error: "MODEL_NOT_CONFIGURED",
        message: "模型模式下还没填服务地址、模型名和密钥",
      },
      409,
    );
  }

  // 两个开关都关着 = 没有任何可生成的东西。不拦的话会原样返回一段“成功”，
  // A 只会觉得按钮坏了（和「模型吐散文被当成成功」是同一类坑）。
  if (!parsed.data.aiStyleEnabled && !parsed.data.analysisEnabled)
    return c.json(
      {
        error: "NOTHING_TO_ENABLE",
        message: "AI 味改写和深度思考反推都关着，去设置页打开其中一个再处理",
      },
      409,
    );

  // §24.4 限速 + §9.3 条件 5：同会话串行、有最小间隔。计数在内存 store 里，会话清理时一并删。
  const now = Date.now();
  if (
    !memoryStore.allowProcess(
      id,
      now,
      config.processMinIntervalSeconds * 1000,
      config.processPerMinute,
    )
  ) {
    return c.json(
      { error: "RATE_LIMITED", message: "点得太快了，等几秒再处理" },
      429,
    );
  }
  if (!memoryStore.beginProcess(id)) {
    return c.json(
      { error: "GENERATION_IN_PROGRESS", message: "上一次处理还没结束" },
      409,
    );
  }

  try {
    // 有备无患：把这条问题标成“处理中”，B 侧继续显示输入中，A 侧列表也能看出状态。
    if (pending.state === "WAITING_A")
      memoryStore.transitionPending(id, pending.id, "GENERATING");

    const outcome = await runAssist({
      draft: parsed.data.draft,
      question: pending.body,
      recent: memoryStore.recentMessagesForModel(
        id,
        config.modelContextRounds,
        repo.countRounds(id),
      ),
      aiStyleEnabled: parsed.data.aiStyleEnabled,
      analysisEnabled: parsed.data.analysisEnabled,
      styleLevel: parsed.data.styleLevel ?? assist.styleLevel,
      mode,
      skillRegistry: getSkillRegistry(),
    });

    if (!outcome.ok) {
      logger.warn("assist failed", {
        stage: "assist",
        mode,
        errorCode: outcome.failure.code,
      });
      return c.json(
        { error: outcome.failure.code, message: outcome.failure.reason },
        PROCESS_HTTP[outcome.failure.code],
      );
    }

    const result = outcome.result;
    // A 自己写好了过程：以它为准（人工写的也算「已确认」），但闸口一次都不少——
    // 「这是我照着草稿在后台拼的」这种话绝不能因为出自 A 之手就放行给 B。
    let analysisSummary = result.analysisSummary;
    const manual = parsed.data.analysisManual?.trim();
    if (manual && parsed.data.analysisEnabled) {
      const check = checkManualAnalysis(manual);
      if (!check.ok) {
        logger.warn("manual analysis rejected", {
          stage: "assist",
          mode,
          errorCode: "INVALID_MODEL_OUTPUT",
        });
        return c.json(
          {
            error: "INVALID_MODEL_OUTPUT",
            message: `你写的这段过程没过自检：${check.failure.reason}`,
          },
          422,
        );
      }
      analysisSummary = manual;
    }

    const processId = randomUUID();
    memoryStore.rememberProcess({
      id: processId,
      sessionId: id,
      replyHash: hashText(result.reply),
      analysisHash: hashText(analysisSummary),
      analysisSummary,
      styleLevel: result.styleLevel,
      mode: result.mode,
      scene: result.scene,
      skillRefs: result.skillRefs,
      createdAtMs: now,
    });

    return c.json(
      {
        processId,
        reply: result.reply,
        analysisSummary,
        styleLevel: result.styleLevel,
        scene: result.scene,
        warnings: result.warnings,
        meta: {
          mode: result.mode,
          skillRefs: result.skillRefs,
          latencyMs: result.latencyMs,
          calls: result.calls,
        },
      } satisfies ProcessResponse,
      200,
    );
  } finally {
    memoryStore.endProcess(id);
  }
});

// A 手工确认（PRD §6.6「编辑并确认摘要」/「改过正文就要重新确认摘要」）：
// 只前移服务端存的那两个哈希，不重新生成任何内容。确认动作本身也要过同一套闸，
// 不然 A 可以把「其实这是我在后台写的」确认进去发给 B。
app.post("/:id/process/:processId/confirm", async (c) => {
  const id = c.req.param("id");
  const processId = c.req.param("processId");
  const parsed = confirmSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "INVALID_BODY" }, 400);

  const record = memoryStore.findProcess(id, processId);
  if (!record)
    return c.json(
      {
        error: "ANALYSIS_STALE",
        message: "这次生成结果已经过期，重新处理一次",
      },
      409,
    );

  const reply = parsed.data.reply ?? null;
  const analysis = parsed.data.analysisSummary ?? null;
  if (analysis !== null) {
    const check = checkManualAnalysis(analysis);
    if (!check.ok)
      return c.json(
        { error: check.failure.code, message: check.failure.reason },
        422,
      );
    memoryStore.updateProcessAnalysis(
      id,
      processId,
      analysis,
      hashText(analysis),
    );
  }
  if (reply !== null)
    memoryStore.updateProcessReply(id, processId, hashText(reply));

  const updated = memoryStore.findProcess(id, processId);
  return c.json({
    processId,
    replyHashMatch: !!updated && updated.replyHash === hashText(reply ?? ""),
    analysisSummary: updated?.analysisSummary ?? "",
  });
});

// A 发送回复。阶段2 三件事在这里串起来：记轮次（缺口2）、判揭晓（缺口3）、幂等防重试重复计数。
//
// 为什么 A 侧也要求 Idempotency-Key：开发文档 §缺口2 设想用 INSERT OR IGNORE 去重，
// 但 round_index 取自当前轮数，重放同一次请求时轮数已经变了，去不掉重复轮次；
// PRD §10 又明确要求「前端网络重试不能产生重复轮次」，所以按 B 侧同一套幂等机制收口。
app.post("/:id/messages", async (c) => {
  const id = c.req.param("id");
  const db = getDb();
  const repo = new SessionRepository(db);

  let row: SessionRow;
  try {
    row = repo.requireById(id);
  } catch (err) {
    if (err instanceof SessionNotFoundError) return c.notFound();
    throw err;
  }

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

  // 先只读地看一眼有没有待回复的 B 问题：PRD §5.2 规定 B 单独发送不计轮次，
  // 只有「A 的回复消费掉一个 B 问题」才算完成一轮，所以判断必须在写入前做。
  const oldest = memoryStore.oldestWaiting(id);

  const idempotency = new IdempotencyStore(db);
  try {
    const result = idempotency.resolve<AReplyResponse>(
      idempotencyKey,
      id,
      rawBody,
      () => {
        // 阶段4 一致性闸门（PRD §6.6）：带了 processId 就必须证明“发出去的正文正是那次生成的正文”。
        // 放在幂等工厂内部：网络重放走缓存分支，不会被这道闸二次拦下。
        const processId = parsed.data.processId;
        let analysisSummary: string | null = null;
        let assistMeta: MessageAssistMeta | null = null;
        if (processId) {
          const record = memoryStore.findProcess(id, processId);
          if (!record || record.replyHash !== hashText(parsed.data.body)) {
            throw new AnalysisStaleError();
          }
          analysisSummary = record.analysisSummary || null;
          assistMeta = {
            mode: record.mode,
            styleLevel: record.styleLevel,
            scene: record.scene ?? undefined,
            skillRefs: record.skillRefs,
            processId,
          };
        }

        // 系统安全过滤放在一致性校验之后、写入消息之前：hash 仍核对 A 确认的原稿，
        // 但 B 能拿到的正文与思考过程都只会是屏蔽后的版本。
        const filteredBody = maskBlockedContent(parsed.data.body);
        const filteredAnalysis = analysisSummary
          ? maskBlockedContent(analysisSummary)
          : null;

        if (row.state === "WAITING") {
          repo.transitionState(id, "ACTIVE");
        }

        const message = memoryStore.appendMessage(id, "A", filteredBody.text, {
          analysisSummary: filteredAnalysis?.text ?? null,
          meta: assistMeta ?? undefined,
        });

        let roundCount = repo.countRounds(id);
        let countedRound = false;
        let session = repo.requireById(id);

        if (oldest) {
          // WAITING_A 或 GENERATING（阶段4：处理草稿已把它推到 GENERATING）都要先过 READY 再发出。
          // GENERATING -> SENDING 在状态机里是非法跳，直接发会 500，这条路径必须显式补上。
          if (oldest.state === "WAITING_A" || oldest.state === "GENERATING") {
            memoryStore.transitionPending(id, oldest.id, "READY");
          }
          memoryStore.transitionPending(id, oldest.id, "SENDING");
          memoryStore.transitionPending(id, oldest.id, "DELIVERED");
          // 轮次 + 揭晓判断放在同一个 SQLite 事务里（PRD §16.6）。
          const done = repo.completeRound(id);
          if (done) {
            roundCount = done.rounds;
            countedRound = true;
            session = done.row;
          }
        }

        return {
          message,
          contentFilter: {
            applied:
              filteredBody.matchedTerms.length > 0 ||
              (filteredAnalysis?.matchedTerms.length ?? 0) > 0,
            matchedCount: new Set([
              ...filteredBody.matchedTerms,
              ...(filteredAnalysis?.matchedTerms ?? []),
            ]).size,
          },
          countedRound,
          roundCount,
          roundLimit: config.roundLimit,
          session: toSessionSummary(session),
        };
      },
    );
    return c.json(result, 201);
  } catch (err) {
    if (err instanceof IdempotencyConflictError) {
      return c.json({ error: "IDEMPOTENCY_CONFLICT" }, 409);
    }
    if (err instanceof AnalysisStaleError) {
      return c.json(
        {
          error: "ANALYSIS_STALE",
          message: "正文跟那次生成的不一样了，重新处理一次或确认摘要",
        },
        409,
      );
    }
    throw err;
  }
});

app.post("/:id/reveal", (c) => {
  const id = c.req.param("id");
  const repo = new SessionRepository(getDb());
  try {
    const row = repo.reveal(id, "OWNER_ACTION");
    return c.json({ session: toSessionSummary(row) });
  } catch (err) {
    if (err instanceof SessionNotFoundError) return c.notFound();
    if (err instanceof InvalidTransitionError)
      return c.json({ error: "ALREADY_REVEALED" }, 409);
    throw err;
  }
});

// A 页面心跳（PRD §17.1 已列该接口）。阶段2 用 REST 轮询代替 WebSocket 应用层心跳，
// 超时判定见 maintenance.ts：超过 heartbeatIntervalSeconds + heartbeatGraceSeconds 判为失联。
app.post("/:id/heartbeat", (c) => {
  const id = c.req.param("id");
  const repo = new SessionRepository(getDb());
  const row = repo.touchHeartbeat(id);
  if (!row) return c.notFound();
  const response: HeartbeatResponse = {
    ok: true,
    lastOwnerHeartbeatAt: row.last_owner_heartbeat_at ?? null,
    serverTime: new Date().toISOString(),
  };
  return c.json(response);
});

// A 主动关闭：走和心跳超时、10 小时过期完全相同的幂等清理事务（PRD §16.6）。
// 关闭即删除会话行与内存正文，不留「已结束但仍可查询」的中间态。
app.post("/:id/close", (c) => {
  const id = c.req.param("id");
  const repo = new SessionRepository(getDb());
  const deleted = repo.cleanup(id);
  memoryStore.clearSession(id);
  if (!deleted) return c.notFound();
  return c.json({ ok: true });
});

export default app;

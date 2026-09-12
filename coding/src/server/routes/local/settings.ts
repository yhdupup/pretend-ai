import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../../db/index.js";
import { SettingsRepository } from "../../settings/repository.js";
import { AVATAR_IDS, MAX_AVATAR_DATA_CHARS } from "../../../shared/avatars.js";
import {
  chatCompletion,
  detectApiPrefix,
  ModelCallError,
  resetTokenBudget,
} from "../../../model/adapter.js";
import {
  clearCredentials,
  credentialsView,
  missingText,
  resolveDraft,
  setCredentials,
} from "../../../model/credentials.js";
import {
  getSkillRegistry,
  toPublicSkillState,
} from "../../../assist/skills/loader.js";
import { config } from "../../config.js";
import { logger } from "../../logger.js";
import type { LocalProfile, ModelTestResponse } from "../../../shared/types.js";

// 本机设置接口（PRD §17.1）。
// - GET  /api/local/settings：读取，供创建窗口与设置页预填
// - PUT  /api/local/settings/profile：保存 A 本机身份（揭晓时展示给 B 的名称与头像）
// - PUT  /api/local/settings/assist：两个开关 + 生成模式 + AI 味档位（阶段4，落 SQLite）
// - PUT  /api/local/settings/model：模型服务地址/模型名/密钥（阶段4，**只进内存**，见 §9.4）
// - DELETE /api/local/settings/model：清掉内存里的密钥
// - POST /api/local/settings/model/test：连通性测试，失败只回类型码

const app = new Hono();

const profileSchema = z.object({
  ownerName: z.string().min(1).max(40),
  ownerAvatarId: z.enum(AVATAR_IDS),
  // A 上传的身份头像：形状闸在 sanitizeAvatarData（只收 png/jpeg/webp 的纯 base64），
  // 这里只挡体量，免得一个 8MB 的字符串把 SQLite 行撑肥。不过一律静默退回内置头像。
  ownerAvatarData: z.string().max(MAX_AVATAR_DATA_CHARS).optional(),
  defaultRevealMessage: z.string().min(1).max(300),
});

const assistSchema = z.object({
  mode: z.enum(["manual", "rules", "user_model"]).optional(),
  aiStyleEnabled: z.boolean().optional(),
  analysisEnabled: z.boolean().optional(),
  styleLevel: z.enum(["轻微", "明显", "浓郁"]).optional(),
});

// baseUrl 只做形状检查（协议 + 可解析），真正的 https 校验在 adapter 里做，
// 免得这里放行、那里拒绝的原因对不上。本机 http stub 要能填进去测。
const modelSchema = z.object({
  baseUrl: z.string().max(300).optional(),
  modelId: z.string().max(200).optional(),
  apiKey: z.string().max(400).optional(),
  mode: z.enum(["manual", "rules", "user_model"]).optional(),
});

app.get("/", (c) => {
  const settings = new SettingsRepository(getDb());
  const registry = getSkillRegistry();
  return c.json({
    profile: settings.get(),
    assist: settings.assist(),
    model: { ...credentialsView(), mode: settings.assist().mode },
    // Skill 生效状态一并回：A 在设置页就能看到「路径配错了」，不用等到点处理草稿才发现。
    skills: {
      aiStyle: toPublicSkillState(registry.aiStyle),
      analysis: toPublicSkillState(registry.analysis),
    },
    skillConfigError: registry.configError,
    limits: {
      maxReplyChars: config.maxReplyChars,
      maxAnalysisChars: config.maxAnalysisChars,
      processPerMinute: config.processPerMinute,
      processMinIntervalSeconds: config.processMinIntervalSeconds,
    },
  });
});

app.put("/profile", async (c) => {
  const parsed = profileSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "INVALID_BODY" }, 400);
  const settings = new SettingsRepository(getDb());
  const profile: LocalProfile = settings.save({
    ...parsed.data,
    ownerAvatarData: parsed.data.ownerAvatarData ?? "",
  });
  return c.json({ profile });
});

app.put("/assist", async (c) => {
  const parsed = assistSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "INVALID_BODY" }, 400);
  const settings = new SettingsRepository(getDb());
  return c.json({ assist: settings.saveAssist(parsed.data) });
});

// 模型凭证：写内存，不写库、不写文件（PRD §9.4）。响应里永远只有 hasKey，没有 key。
app.put("/model", async (c) => {
  const parsed = modelSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "INVALID_BODY" }, 400);
  const { mode, ...credentials } = parsed.data;
  const { accepted, missing } = setCredentials(credentials);
  // 换模型或换地址时把学到的输出预算忘掉：新那台可能根本不吃思考字段，
  // 留着旧值等于白给它一个大上限。
  if (accepted) resetTokenBudget();
  if (mode) new SettingsRepository(getDb()).saveAssist({ mode });
  // 配不齐时保持原凭证不动（改地址不该顺手把 key 清了），所以这里不回错误码，只回当前状态。
  const view = {
    ...credentialsView(),
    mode: new SettingsRepository(getDb()).assist().mode,
  };
  logger.info("model credentials updated", {
    stage: "model",
    hasKey: view.hasKey,
    // 只记字段名（baseUrl/modelId/apiKey）与缺项列表：存住「为什么没生效」，不记任何值。
    accepted,
    missing: missing.join(",") || undefined,
  });
  return c.json({ model: view, accepted, missing });
});

app.delete("/model", (c) => {
  clearCredentials();
  resetTokenBudget();
  logger.info("model credentials cleared", { stage: "model", hasKey: false });
  return c.json({ ok: true });
});

// 错误码只有三种去向：没配好（改配置）、被限流（等）、上游不行（换一家或重试）。
function testErrorCode(
  kind: string,
):
  | "RATE_LIMITED"
  | "MODEL_NOT_CONFIGURED"
  | "MODEL_CONFIG_INVALID"
  | "MODEL_UNAVAILABLE" {
  if (kind === "RATE_LIMIT") return "RATE_LIMITED";
  if (kind === "NOT_CONFIGURED") return "MODEL_NOT_CONFIGURED";
  if (kind === "CONFIG" || kind === "BAD_ENDPOINT" || kind === "BAD_REQUEST")
    return "MODEL_CONFIG_INVALID";
  return "MODEL_UNAVAILABLE";
}

// 失败种类 → 界面文案。每一条都指向一个具体动作：光说「连不上」用户只能反复点同一个按钮。
function testFailureText(
  kind: string,
  modelId: string,
  httpStatus?: number,
  bodyKind?: string,
  suggestedBaseUrl?: string | null,
): string {
  switch (kind) {
    case "AUTH":
      return "鉴权失败：密钥或账号不对（地址和模型名都是通的）";
    case "TIMEOUT":
      return "超时：这个网络连不上它";
    case "RATE_LIMIT":
      return "被限流：等一会儿再试";
    case "NOT_CONFIGURED":
      return "还没配好服务地址、模型名和密钥（重启服务后内存会清空，要重填）";
    case "CONFIG":
      return "地址这一项不合法：要写成 https://主机/v1 的形式，不能用 http，也不能填网页地址";
    case "BAD_ENDPOINT": {
      const shape =
        bodyKind === "empty"
          ? "空响应"
          : bodyKind === "html"
            ? "一个网页（多半是首页、登录页，或本项目自己的地址）"
            : bodyKind === "text"
              ? "一段纯文本"
              : "非 JSON 内容";
      // 探到了活的接口前缀，就说具体那个地址，不再举别人家的例子（实跑撞的就是：
      // 用户照第三方给的地址填，界面只给一句通用规劝，看不出到底是哪一层不对）。
      const advice = suggestedBaseUrl
        ? `这台机器在 ${suggestedBaseUrl} 下面有对话接口（刚才不带密钥探了一下，那个路径回的是接口 JSON）。把服务地址改成 ${suggestedBaseUrl} 再测。`
        : `只填到 /v1 根地址（例：https://api.stepfun.com/v1），不要带 /chat/completions，也不要填控制台网页地址`;
      return `地址这一层不对：那个路径回的是${shape}，不是对话接口。${advice}`;
    }
    case "BAD_REQUEST":
      return `地址是通的，但上游拒了这次请求（HTTP ${httpStatus ?? "??"}）：多半是模型名不属于这个地址，去供应商核对「${modelId || "（模型名为空）"}」`;
    case "TRUNCATED":
      return "连得上，但这台模型的输出预算全花在思考上了：把 MODEL_MAX_TOKENS 调到 2000 以上，或换不思考的模型";
    default:
      return "连上了，但它回的形状读不出正文（不是 OpenAI 兼容的 chat/completions 响应）";
  }
}

// 测试可以带「界面上还没保存的这三项」：不传 = 测内存里已保存的那套；传了 = 测框里这套且不写内存。
// 以前只能测已保存的，配合上面「不齐就不存」的保存规则，会出现屏幕上的地址和实际被打的地址不是一个。
const testSchema = z.object({
  baseUrl: z.string().max(300).optional(),
  modelId: z.string().max(200).optional(),
  apiKey: z.string().max(400).optional(),
});

// 连通性测试（PRD §17.1 settings/model/test）。失败必须翻译成类型码：
// 供应商原文里常带请求 URL、配额、账号名，这些不能经 A 页面二次泄露（§18.6）。
app.post("/model/test", async (c) => {
  const parsed = testSchema.safeParse(await c.req.json().catch(() => null));
  const draft = parsed.success ? parsed.data : undefined;
  const resolved = resolveDraft(draft ?? {});
  const target = resolved.credentials;
  if (!target) {
    const response: ModelTestResponse = {
      ok: false,
      errorCode: "MODEL_NOT_CONFIGURED",
      kind: "NOT_CONFIGURED",
      drafted: !!draft,
      message: `${
        draft ? "框里这几项" : "本机内存里"
      }还缺 ${missingText(resolved.missing)}：地址、模型名、密钥三项齐了才能测（密钥只存在内存里，重启服务后要重填）`,
    };
    return c.json(response, 400);
  }
  const modelId = target.modelId;
  try {
    const { latencyMs, endpointUrl } = await chatCompletion(
      "你是连通性探针。",
      "只回复一个字：好",
      draft,
    );
    const response: ModelTestResponse = {
      ok: true,
      latencyMs,
      modelId,
      // 通了也要说清打的是哪个地址：不然“测试成功”会被当成“保存成功”，两边以为的是同一件事。
      testedBaseUrl: endpointUrl,
      drafted: !!draft,
    };
    return c.json(response);
  } catch (err) {
    const callError = err instanceof ModelCallError ? err : null;
    const kind = callError?.kind ?? "NETWORK";
    const httpStatus = callError?.httpStatus;
    const endpointPath = callError?.endpointPath;
    const endpointUrl = callError?.endpointUrl;
    const bodyKind = callError?.bodyKind;
    // 只有「地址回的是网页/空/纯文本」这一类才值得多打一下：那才是“不知道前缀在哪”的情形。
    const suggestedBaseUrl =
      kind === "BAD_ENDPOINT" && endpointUrl
        ? await detectApiPrefix(endpointUrl)
        : null;
    const response: ModelTestResponse = {
      ok: false,
      // 地址/模型名填错属于配置错，不是「上游临时不可用」：错误码分开，A 端才能说
      // 「去改这一项」而不是让用户等一会儿再试（实跑撞的就是这个混淆）。
      errorCode: testErrorCode(kind),
      kind,
      httpStatus,
      endpointPath,
      endpointUrl,
      bodyKind,
      message: testFailureText(
        kind,
        modelId,
        httpStatus,
        bodyKind,
        suggestedBaseUrl,
      ),
      suggestedBaseUrl: suggestedBaseUrl ?? undefined,
      testedBaseUrl: endpointUrl,
      drafted: !!draft,
    };
    logger.warn("model test failed", {
      stage: "model",
      errorCode: kind,
      status: httpStatus,
      endpointPath,
      // 主机名不落日志（§18.6）；bodyKind 只是「像网页还是像 JSON」的分类标签
      bodyKind,
    });
    // 配置类（没填 / 填错）一律 400：让用户知道要改的是自己填的那几项，不是等一会儿。
    return c.json(
      response,
      response.errorCode === "MODEL_NOT_CONFIGURED" ||
        response.errorCode === "MODEL_CONFIG_INVALID"
        ? 400
        : 502,
    );
  }
});

export default app;

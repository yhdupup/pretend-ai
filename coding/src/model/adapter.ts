import { config } from "../server/config.js";
import {
  getCredentials,
  missingText,
  redactSecrets,
  resolveDraft,
  type ModelDraft,
} from "./credentials.js";
import { logger } from "../server/logger.js";

/**
 * 通用自备模型适配器（PRD §9.1「第一版只支持与项目定义的通用聊天接口兼容的服务」）。
 *
 * 只做一件事：把 (system 指令, user 资料) 发成一次 OpenAI 兼容的
 * `POST {base}/chat/completions`，拿回一段文本。结构化与校验都不在这里（§4.6）。
 *
 * 失败一律折成 `ModelCallError{kind}`：供应商响应原文与密钥都不外传（§8.3/§18.6）。
 * 唯一例外是「本次到底打了哪个地址」——那是 A 自己填进去的配置值，回显给 A 核对才有意义，
 * 一次都不进日志（§18.6），也绝不进任何 B 侧响应。
 */

/**
 * 上游调用失败的粗分类（PRD §9.5）：界面只认这几个码，具体 HTTP 状态与响应体一律留在服务端日志里。
 *
 * TRUNCATED 是实跑撞出来的坑：带思考字段的模型（reasoning_content 那一类）会把输出预算先花在思考上，
 * finish_reason 变成 length、content 只剩空字符串或半截 JSON。连接测试问的是「只回复一个字」，
 * 两个字都不到预算，所以测试一路绿灯、真实按钮必失败。单列一类用来换大预算重试 + 给人话原因。
 */
export type ModelFailureKind =
  | "AUTH"
  | "NETWORK"
  | "TIMEOUT"
  | "BAD_RESPONSE"
  /** 地址填法不对：请求路径下没有对话接口（实跑见过 404 空体与网关默认页）。 */
  | "BAD_ENDPOINT"
  /** 上游收了请求但判定请求不合法（实跑见过：地址对、但这个入口不认这个模型名）。 */
  | "BAD_REQUEST"
  /** 三项凭证压根没配齐（区别于 CONFIG：那是填了但填错）。 */
  | "NOT_CONFIGURED"
  | "TRUNCATED"
  | "RATE_LIMIT"
  | "CONFIG";

export class ModelCallError extends Error {
  /** httpStatus 与 endpointPath 可以往外带：都不含密钥与上游正文。响应体一律不带。 */
  readonly httpStatus?: number;
  /** 只含路径。实跑见过 /v1/chat/completions/chat/completions 这种套娃，看一眼就知道地址多填了一层。 */
  readonly endpointPath?: string;
  /** 完整请求地址（含主机名，绝不含密钥）：只回给 A 本机核对「我填的到底是哪」，不进日志。 */
  readonly endpointUrl?: string;
  /** 失败时响应体像什么：空 / 网页 / 纯文本 / JSON。只是一个分类标签，不取内容。 */
  readonly bodyKind?: "empty" | "html" | "text" | "json";

  constructor(
    readonly kind: ModelFailureKind,
    readonly retryable: boolean,
    message?: string,
    extra: {
      httpStatus?: number;
      endpointPath?: string;
      endpointUrl?: string;
      bodyKind?: "empty" | "html" | "text" | "json";
    } = {},
  ) {
    super(message ?? kind);
    this.name = "ModelCallError";
    this.httpStatus = extra.httpStatus;
    this.endpointPath = extra.endpointPath;
    this.endpointUrl = extra.endpointUrl;
    this.bodyKind = extra.bodyKind;
  }
}

export interface ChatCompletionResult {
  text: string;
  latencyMs: number;
  httpStatus: number;
  /** 上游自报的结束原因（stop / length / ...），缺失时 null。只用来判截断，不进日志正文。 */
  finishReason?: string | null;
  /** 本次是否换过更大的输出预算（推理模型的自愈痕迹，给提示文案用）。 */
  escalated?: boolean;
  /** 本次实际请求的完整地址（不含密钥）：只给本机 A 核对配置，不进日志。 */
  endpointUrl?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// 并发闸门：默认 1（MODEL_MAX_CONCURRENCY）。阶段三自测连开隧道被限流的教训直接搬过来 ——
// 连着点只会让上游更久地拒绝你。
let active = 0;
const queue: Array<() => void> = [];

async function acquireSlot(): Promise<() => void> {
  if (active < config.modelMaxConcurrency) {
    active += 1;
  } else {
    await new Promise<void>((resolve) => queue.push(resolve));
    active += 1;
  }
  return () => {
    active -= 1;
    const next = queue.shift();
    if (next) next();
  };
}

function validateBaseUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ModelCallError("CONFIG", false, "服务地址不是一个合法 URL");
  }
  // 本机 stub（测试用）允许 http，其余一律要求 https：密钥不能裸奔在明链上。
  const isLocal =
    url.protocol === "http:" &&
    /^(127\.0\.0\.1|localhost|\[::1\])$/.test(url.hostname);
  if (url.protocol !== "https:" && !isLocal) {
    throw new ModelCallError("CONFIG", false, "服务地址必须用 https");
  }
  return url;
}

async function once(
  body: unknown,
  bearer: string,
  baseUrl: string,
): Promise<Omit<ChatCompletionResult, "escalated">> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.modelTimeoutMs);
  const startedAt = Date.now();
  const url = endpointFor(baseUrl).toString();
  const endpointPath = new URL(url).pathname;
  let response: Response;
  try {
    response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    throw new ModelCallError(
      aborted ? "TIMEOUT" : "NETWORK",
      true,
      aborted ? "上游超时" : "连不上上游",
    );
  } finally {
    clearTimeout(timer);
  }

  const status = response.status;
  if (status === 401 || status === 403) {
    throw new ModelCallError("AUTH", false, `上游拒绝凭证（HTTP ${status}）`, {
      httpStatus: status,
      endpointPath,
      endpointUrl: url,
    });
  }
  if (status === 429) {
    throw new ModelCallError("RATE_LIMIT", true, `上游限流（HTTP 429）`, {
      httpStatus: status,
      endpointPath,
      endpointUrl: url,
    });
  }
  if (status >= 500) {
    throw new ModelCallError("NETWORK", true, `上游出错（HTTP ${status}）`, {
      httpStatus: status,
      endpointPath,
      endpointUrl: url,
    });
  }
  if (!response.ok) {
    // 4xx 非鉴权类：重试没意义，而且必须分清「地址不对」还是「请求不对」——
    // 以前一律报 BAD_RESPONSE，用户只能看到一句没用的「上游没给出能读的结果」。
    // 实跑见过三种 404：空响应体（地址多填了一层 chat/completions）、text/plain（漏了 /v1，
    // 打到网关默认页）、带 error 字段的 JSON（地址对，但这个入口不认这个模型名）。
    // 判据只用「是不是带 error 字段的 JSON」这一个布尔，不取里面任何文本（§18.6）。
    const peeked = await peekBody(response);
    const jsonError = peeked.kind === "json" && peeked.hasError;
    const shape =
      (status === 404 || status === 405) && !jsonError
        ? "BAD_ENDPOINT"
        : "BAD_REQUEST";
    throw new ModelCallError(
      shape,
      false,
      `上游返回 HTTP ${status}（请求路径 ${endpointPath}，回的是${describeBody(peeked.kind)}）`,
      {
        httpStatus: status,
        endpointPath,
        endpointUrl: url,
        bodyKind: peeked.kind,
      },
    );
  }

  let payload: unknown;
  const bodyText = redactSecrets(await response.text());
  try {
    payload = JSON.parse(bodyText);
  } catch {
    const peeked = classifyBody(bodyText, response.headers.get("content-type"));
    // 200 + 非 JSON：改模型名、改密钥都没用，要改的是地址本身。
    // 实跑见过 200 + 空体（网关吃掉了请求）与 200 + 网页（把首页/文档站当成了 API）。
    throw new ModelCallError(
      "BAD_ENDPOINT",
      false,
      `HTTP 200，但回的是${describeBody(peeked.kind)}，不是接口 JSON（请求路径 ${endpointPath}）`,
      {
        httpStatus: status,
        endpointPath,
        endpointUrl: url,
        bodyKind: peeked.kind,
      },
    );
  }
  const text = pickText(payload);
  const finishReason = pickFinishReason(payload);
  if (text === null) {
    // 200 但一句正文都没有，还得了一个 length：推理模型把预算全花在思考字段上就是这个形状
    // （content:null + reasoning_content 有一大段）。回成空正文让上层去换预算，
    // 别报成「格式不认识」——那是地址问题才会见的形状。
    if (finishReason === "length")
      return {
        text: "",
        latencyMs: Date.now() - startedAt,
        httpStatus: response.status,
        finishReason,
      };
    throw new ModelCallError(
      "BAD_RESPONSE",
      true,
      `上游响应里没有可读取的文本字段（顶层字段 ${shapeOf(payload)}）`,
      {
        httpStatus: status,
        endpointPath,
        endpointUrl: url,
        bodyKind: "json",
      },
    );
  }
  return {
    text,
    latencyMs: Date.now() - startedAt,
    httpStatus: response.status,
    finishReason,
    endpointUrl: url.toString(),
  };
}

/**
 * 失败响应只许问两句：像什么形状、是不是带 error 字段的 JSON。
 * 原文一律不外传（§18.6），所以这里只回布尔与分类标签。
 */
type BodyKind = "empty" | "html" | "text" | "json";

function classifyBody(text: string, contentType: string | null): {
  kind: BodyKind;
  hasError: boolean;
} {
  const head = text.trim();
  if (head === "") return { kind: "empty", hasError: false };
  if (head.startsWith("<")) return { kind: "html", hasError: false };
  if (contentType?.includes("html")) return { kind: "html", hasError: false };
  if (head.startsWith("{") || head.startsWith("[")) {
    try {
      const parsed = JSON.parse(head) as Record<string, unknown> | null;
      return {
        kind: "json",
        hasError: !!parsed && typeof parsed === "object" && parsed.error != null,
      };
    } catch {
      // 声称是 JSON 却解析不了，按纯文本处理
    }
  }
  return { kind: "text", hasError: false };
}

async function peekBody(response: Response): Promise<{
  kind: BodyKind;
  hasError: boolean;
}> {
  try {
    return classifyBody(
      redactSecrets((await response.text()).slice(0, 4096)),
      response.headers.get("content-type"),
    );
  } catch {
    return { kind: "empty", hasError: false };
  }
}

const BODY_TEXT: Record<BodyKind, string> = {
  empty: "空响应",
  html: "一个网页（多半是首页或登录页）",
  text: "一段纯文本",
  json: "JSON",
};

function describeBody(kind: BodyKind): string {
  return BODY_TEXT[kind];
}

/** 只取字段名，用在「这家回的形状我不认识」时给人看一眼结构；一个值都不取。 */
function shapeOf(payload: unknown): string {
  if (payload === null || typeof payload !== "object") return typeof payload;
  const keys = Object.keys(payload as Record<string, unknown>);
  const choices = (payload as { choices?: unknown }).choices;
  if (Array.isArray(choices) && choices[0] && typeof choices[0] === "object")
    keys.push(`choices[0]:${Object.keys(choices[0] as object).join("+")}`);
  return keys.slice(0, 8).join(",") || "空对象";
}

/**
 * 把服务地址拼成对话接口地址。
 *
 * ⚠️ 不用 `new URL("chat/completions", base)`：base 带查询参数（`/v1?api-version=...` 这类）时，
 * 补上去的 `/` 会落进查询串里，相对解析就把**路径最后一段整个替掉**，
 * 于是用户填的 `/v1` 被静悄悄吃掉、打到主机根（实跑测到）。
 * 现在 pathname 与 search 都自己拼：不丢层、不串味。
 */
function endpointFor(baseUrl: string): URL {
  const base = new URL(baseUrl);
  const path = base.pathname.replace(/\/+$/, "");
  const endpoint = new URL(`${base.origin}${path}/chat/completions`);
  if (base.search) endpoint.search = base.search;
  return endpoint;
}

/**
 * 内容字段的三种形状：字符串、OpenAI 式的文本块数组、没有。
 * 网关把 choices[0].message.content 回成 [{type:"text",text:"..."}] 很常见，
 * 只认字符串的话，这种上游会被当成「没配置」直接卡死（同一形状，只是更啰嗦）。
 */
function contentToText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const parts = value
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object") {
        const text = (part as { text?: unknown }).text;
        if (typeof text === "string") return text;
      }
      return null;
    })
    .filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join("") : null;
}

/**
 * 只认 OpenAI 兼容形状。message / delta / choices[0].text / 顶层 output_text 四种位置都试一遍，
 * 就停在这里，不再猜别的字段：再猜就要把推理模型的思考字段误当成本次输出了
 * （思维链永不展示、永不转发，PRD §8.3）。
 */
function pickText(payload: unknown): string | null {
  const root = (payload ?? {}) as Record<string, unknown>;
  const choices = Array.isArray(root.choices) ? root.choices : null;
  const first = (choices?.[0] ?? {}) as Record<string, unknown>;
  const containers = [first.message, first.delta, first];
  for (const container of containers) {
    if (!container || typeof container !== "object") continue;
    const box = container as Record<string, unknown>;
    const text = contentToText(box.content) ?? contentToText(box.text);
    if (text !== null) return text;
  }
  return contentToText(root.output_text);
}

/** finish_reason 是判断「正文被输出预算墙断」的唯一信号，别的地方拿不到。 */
function pickFinishReason(payload: unknown): string | null {
  const root = (payload ?? {}) as Record<string, unknown>;
  const choices = Array.isArray(root.choices) ? root.choices : null;
  const first = (choices?.[0] ?? {}) as Record<string, unknown>;
  for (const source of [first.finish_reason, root.stop_reason]) {
    if (typeof source === "string" && source !== "") return source;
  }
  return null;
}

// 记住「这台模型至少要多少 token 才吐得出正文」。
// 不记的话每次点按钮都要先花一次注定为空的调用（实测一个空调用 ≈ 7 秒），白等一倍时间。
// 只记预算数值：换模型/换地址/手动清除时一起清掉（见 resetTokenBudget）。
let learnedMaxTokens: number | null = null;

/** 凭证变了就把学到的预算忘掉：新模型可能根本不需要这么大。 */
export function resetTokenBudget(): void {
  learnedMaxTokens = null;
}

/**
 * 一次上游补全。带超时与有限次重试（§9.5：超时即失败，不做异步补偿）。
 * 重试期间不向任何端转发中间内容（§8.3），失败只向上抛分类码。
 *
 * 两层重试（同一个并发槽里跑完，不会放新请求挤队）：
 * 1) 同预算重试：网络、超时、429、5xx、格式不认识，按 1s/2s/4s 退避；
 * 2) 换大预算一次：正文空或 finish_reason=length。推理模型每次都会先把小预算填满，
 *    同预算下重试只是白花一次钱，所以要换值（MODEL_MAX_TOKENS_ESCALATE）。
 */
/** 探测用的短超时：这一下只是探个形状，不该让「连接测试」多等 30 秒。 */
const PROBE_TIMEOUT_MS = Math.min(config.modelTimeoutMs, 5000);

/**
 * 「通了但回的是网页/空响应」时，同主机再探一次常见前缀，把「该填哪个地址」说成具体的一条。
 *
 * 三条约束：**不带密钥**（一个 authorization 头都不发）、**只打用户已经填过的那台主机**、
 * **只取一个布尔结论**（回的是不是 JSON），响应体一个字节都不取、不进日志。
 * 为什么可行：网关类服务在真正的接口前缀上会回 401/400 的 JSON（「token 不对」），
 * 而静态站对任何路径都回 200 + HTML —— 形状天然不同，不需要拿到密钥就能分开。
 */
export async function detectApiPrefix(
  failedUrl: string,
): Promise<string | null> {
  let base: URL;
  try {
    base = new URL(failedUrl);
  } catch {
    return null;
  }
  const current = base.pathname.replace(/\/+$/, "");
  for (const prefix of ["/v1", "/api/v1"]) {
    if (current === prefix || current.startsWith(`${prefix}/`)) continue; // 刚打过的那层不重复杂
    const endpoint = `${base.origin}${prefix}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // 固定假模型名与一个句点：不携任何用户内容，也不携密钥。
        body: JSON.stringify({
          model: "__probe__",
          messages: [{ role: "user", content: "." }],
          max_tokens: 1,
        }),
        signal: controller.signal,
      });
      logger.info("model endpoint hint probed", {
        stage: "model",
        feature: "ENDPOINT_HINT",
        errorCode: "BAD_ENDPOINT",
        endpointPath: new URL(endpoint).pathname,
        status: response.status,
      });
      // 「回 JSON」还不够：不少网关对**不认识的路径**也回 404 + JSON（实跑撞的就是这台，
      // 它对 /api/v1/chat/completions 回 404 JSON）。404 与 5xx 一律当作「路由不认识这层」，
      // 只有走到鉴权/参数层的（2xx、400、401、403、429）才算「接口确实在这」。
      const ctJson = (response.headers.get("content-type") ?? "").includes("json");
      if (ctJson && response.status !== 404 && response.status < 500)
        return `${base.origin}${prefix}`;
    } catch {
      /* 探不动（连不上/超时）就不给建议，拿猜的当结论比不说更环 */
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

export async function chatCompletion(
  systemPrompt: string,
  userPrompt: string,
  /** 界面上还没保存的那三项（只用于连通性测试）；不传 = 用内存里已保存的。传了也不会写进内存。 */
  draft?: ModelDraft,
): Promise<ChatCompletionResult> {
  const credentials = draft
    ? resolveDraft(draft).credentials
    : getCredentials();
  if (!credentials)
    throw new ModelCallError(
      "NOT_CONFIGURED",
      false,
      draft
        ? `还缺 ${missingText(resolveDraft(draft).missing)}：地址、模型名、密钥三项齐了才能测`
        : "还没配置模型服务（地址、模型名、密钥三项要一起填齐）",
    );
  validateBaseUrl(credentials.baseUrl);

  const release = await acquireSlot();
  const attempts = config.modelRetryTimes + 1;
  let maxTokens = Math.max(config.modelMaxTokens, learnedMaxTokens ?? 0);
  let escalated = maxTokens > config.modelMaxTokens;
  let lastError: ModelCallError | null = null;
  try {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const result = await once(
          {
            model: credentials.modelId,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
            temperature: config.modelTemperature,
            max_tokens: maxTokens,
            stream: false,
          },
          credentials.apiKey,
          credentials.baseUrl,
        );
        const trimmed = result.text.trim();
        // 两种「预算不够」：正文一个字都没给；或 finish_reason=length 且 JSON 连尾巴都没合上。
        // 只看结构不看内容：写完的 JSON 就算上限到了也不丢，交给下面的校验闸判。
        const exhausted =
          trimmed === "" ||
          (result.finishReason === "length" &&
            !trimmed.endsWith("}") &&
            !trimmed.endsWith("]"));
        if (!exhausted) {
          // 这一档能用就记住它：下一次不必再从空正文跑一遍。
          if (escalated) learnedMaxTokens = maxTokens;
          return { ...result, escalated };
        }
        // 同一预算下重试救不了截断：思考字段每次都会先把它填满，所以要换值。
        lastError = new ModelCallError(
          "TRUNCATED",
          !escalated,
          "上游把输出预算花在思考上，正文空了或被截断",
        );
        if (escalated) break;
        const next = config.modelMaxTokensEscalate;
        if (next <= maxTokens) break; // 自愈预算不比当前大：没得换，直接报错
        logger.warn("model output exhausted, retrying with a larger budget", {
          stage: "model",
          errorCode: "TRUNCATED",
          feature: "MODEL_ESCALATE",
          fromTokens: maxTokens,
          toTokens: next,
        });
        escalated = true;
        maxTokens = next;
        learnedMaxTokens = next; // 记下候选档位：下一轮直接从这档起跳，别再花一次空正文的调用
        attempt -= 1; // 换预算不占用普通重试名额
      } catch (err) {
        if (!(err instanceof ModelCallError)) {
          lastError = new ModelCallError(
            "NETWORK",
            true,
            err instanceof Error ? err.message : "上游调用异常",
          );
        } else {
          lastError = err;
        }
        if (!lastError.retryable || attempt === attempts - 1) break;
        // 指数退避：1s、2s、4s（上限 8s）。阶段3 的教训——被限流时密集重试只会续命封禁。
        await sleep(Math.min(2 ** attempt * 1000, 8000));
      }
    }
  } finally {
    release();
  }

  const failure = lastError ?? new ModelCallError("NETWORK", false, "调用失败");
  // 只记 kind 与分类：地址、模型响应、提示词都不落日志（§9.4/§18.6）。
  // 状态码与请求路径都不含密钥与正文，但它们是「为什么连不上」的唯一线索。
  logger.warn("model call failed", {
    errorCode: failure.kind,
    stage: "model",
    escalated,
    status: failure.httpStatus,
    endpointPath: failure.endpointPath,
    bodyKind: failure.bodyKind,
  });
  throw failure;
}

/**
 * 连通性测试（§17.1 的 settings/model/test）：问一个字，看能不能拿到文本。
 * 它只能验「地址 + 模型名 + 密钥」这三件对不上，验不出输出预算：
 * 推理模型对一个字不会思考，对真实 Skill 会，所以测试绿灯不代表两个按钮能用。
 * 真实调用那条路径自己会换大预算重试，不依靠这里。
 */
export async function testConnection(): Promise<{ latencyMs: number }> {
  const result = await chatCompletion(
    "你是连通性探针。",
    "只回复一个字：好",
  );
  return { latencyMs: result.latencyMs };
}

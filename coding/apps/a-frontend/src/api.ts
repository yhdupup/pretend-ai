import type {
  AReplyResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  HeartbeatResponse,
  LocalProfile,
  LocalStatusResponse,
  ModelSettingsView,
  ProcessRequest,
  ProcessResponse,
  SkillState,
  StyleLevel,
  AssistMode,
  SessionDetailResponse,
  SessionSummary,
  TunnelActionResponse,
} from "../../../src/shared/types";

// A 前端 API 封装。所有请求都走同源 Vite dev proxy 转发到 127.0.0.1:8787，
// 携带 credentials 以便浏览器自动附带 bootstrap 兑换后拿到的控制会话 Cookie。

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    /** 服务端给 A 看的人话原因（阶段4：处理草稿失败时必须说清是哪一项被拦下）。 */
    public readonly detail?: string,
    /** 原始响应体：模型测试这类接口不返回 {error} 而返回 {kind,errorCode}，
     *  不带上就会一律显示成 UNKNOWN_ERROR，真实种类全丢（实跑踩过）。 */
    public readonly body?: Record<string, unknown>,
  ) {
    super(code);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
      message?: string;
    } | null;
    throw new ApiError(
      res.status,
      (body && body.error) || "UNKNOWN_ERROR",
      body?.message,
      body ?? undefined,
    );
  }
  return (await res.json()) as T;
}

export function bootstrap(token: string): Promise<{ ok: true }> {
  return request(`/api/local/bootstrap/${encodeURIComponent(token)}`, {
    method: "POST",
  });
}

export function getProfile(): Promise<{ profile: LocalProfile }> {
  return request("/api/local/settings");
}

export function saveProfile(
  profile: LocalProfile,
): Promise<{ profile: LocalProfile }> {
  return request("/api/local/settings/profile", {
    method: "PUT",
    body: JSON.stringify(profile),
  });
}

export function createSession(
  input: CreateSessionRequest,
): Promise<CreateSessionResponse> {
  return request("/api/local/sessions", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getSession(id: string): Promise<SessionDetailResponse> {
  return request(`/api/local/sessions/${encodeURIComponent(id)}`);
}

// 同一次发送（含失败后的重试）必须复用同一个 Idempotency-Key，
// 否则网络重试会重复计轮次（PRD §10，服务端在 /:id/messages 里做了幂等收口）。
let replyKeySeq = 0;
export function newReplyKey(sessionId: string): string {
  replyKeySeq += 1;
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}`;
  return `a-${sessionId}-${replyKeySeq}-${rand}`;
}

/**
 * A 发送回复。阶段4 起可以带 processId：服务端会核对「发出去的正文 == 那次生成的正文」，
 * 对不上返回 409 ANALYSIS_STALE，摘要绝不会跟着错正文发出去（PRD §6.6）。
 */
export function sendReply(
  id: string,
  body: string,
  idempotencyKey: string,
  processId?: string | null,
): Promise<AReplyResponse> {
  return request(`/api/local/sessions/${encodeURIComponent(id)}/messages`, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(processId ? { body, processId } : { body }),
  });
}

export function revealSession(
  id: string,
): Promise<{ session: SessionSummary }> {
  return request(`/api/local/sessions/${encodeURIComponent(id)}/reveal`, {
    method: "POST",
  });
}

export function heartbeat(id: string): Promise<HeartbeatResponse> {
  return request(`/api/local/sessions/${encodeURIComponent(id)}/heartbeat`, {
    method: "POST",
  });
}

export function closeSession(id: string): Promise<{ ok: true }> {
  return request(`/api/local/sessions/${encodeURIComponent(id)}/close`, {
    method: "POST",
  });
}

// ---------- 阶段3：公网通道 ----------

export function getStatus(): Promise<LocalStatusResponse> {
  return request("/api/local/status");
}

export async function tunnelAction(
  action: "start" | "stop" | "reconnect" | "recheck",
): Promise<LocalStatusResponse> {
  const result = await request<TunnelActionResponse>(
    `/api/local/tunnel/${action}`,
    { method: "POST" },
  );
  return result.status;
}

// ---------- 阶段4：AI 能力 ----------

export interface SettingsPayload {
  profile: LocalProfile;
  assist: {
    mode: AssistMode;
    aiStyleEnabled: boolean;
    analysisEnabled: boolean;
    styleLevel: StyleLevel;
  };
  model: ModelSettingsView;
  skills: { aiStyle: SkillState; analysis: SkillState };
  skillConfigError: string | null;
  limits: {
    maxReplyChars: number;
    maxAnalysisChars: number;
    processPerMinute: number;
    processMinIntervalSeconds: number;
  };
}

export function getSettings(): Promise<SettingsPayload> {
  return request("/api/local/settings");
}

export function saveAssist(
  patch: Partial<SettingsPayload["assist"]>,
): Promise<{ assist: SettingsPayload["assist"] }> {
  return request("/api/local/settings/assist", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

export function saveModel(input: {
  baseUrl?: string;
  modelId?: string;
  apiKey?: string;
  mode?: AssistMode;
}): Promise<{
  model: ModelSettingsView;
  accepted: boolean;
  /** 没生效时缺哪几项（只回字段名，不回值）。 */
  missing?: ("baseUrl" | "modelId" | "apiKey")[];
}> {
  return request("/api/local/settings/model", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function clearModel(): Promise<{ ok: true }> {
  return request("/api/local/settings/model", { method: "DELETE" });
}

export interface ModelTestResult {
  ok: boolean;
  latencyMs?: number;
  kind?: string;
  message?: string;
  httpStatus?: number;
  endpointPath?: string;
  /** 实际请求的完整地址（不含密钥）。只回给本机 A 核对配置，不进日志。 */
  endpointUrl?: string;
  /** 同主机不带密钥探到的真接口前缀（能探到时才有）：界面上给一个「按这个填」。 */
  suggestedBaseUrl?: string;
  /** 本次测的是哪个地址（通了也给）。 */
  testedBaseUrl?: string;
  /** true = 测的是框里未保存的这几项；false = 测内存里已保存的那套。 */
  drafted?: boolean;
}

/**
 * 连通性测试失败时服务端回 400/502，这里统一转成 {ok:false}：一个测试按钮不该弹错误框。
 * 注意必须回读响应体里的 kind/message —— 通用错误码字段（error）在这个接口上不存在，
 * 直接拿 err.code 只会得到 UNKNOWN_ERROR，把「地址多填了一层」这种可行动信息全抹掉。
 */
export interface ModelDraftInput {
  baseUrl?: string;
  modelId?: string;
  apiKey?: string;
}

export async function testModel(
  draft?: ModelDraftInput,
): Promise<ModelTestResult> {
  const hasDraft = !!draft && Object.keys(draft).length > 0;
  try {
    return await request<ModelTestResult>("/api/local/settings/model/test", {
      method: "POST",
      // 不传草稿时维持原样（空 body = 测内存里已保存的那套）。
      ...(hasDraft ? { body: JSON.stringify(draft) } : {}),
    });
  } catch (err) {
    if (err instanceof ApiError) {
      const body = err.body ?? {};
      return {
        ok: false,
        kind: typeof body.kind === "string" ? body.kind : err.code,
        message: typeof body.message === "string" ? body.message : err.detail,
        httpStatus:
          typeof body.httpStatus === "number" ? body.httpStatus : undefined,
        endpointPath:
          typeof body.endpointPath === "string"
            ? body.endpointPath
            : undefined,
        endpointUrl:
          typeof body.endpointUrl === "string" ? body.endpointUrl : undefined,
        suggestedBaseUrl:
          typeof body.suggestedBaseUrl === "string"
            ? body.suggestedBaseUrl
            : undefined,
        testedBaseUrl:
          typeof body.testedBaseUrl === "string"
            ? body.testedBaseUrl
            : undefined,
        drafted: typeof body.drafted === "boolean" ? body.drafted : undefined,
      };
    }
    throw err;
  }
}

export function processDraft(
  id: string,
  input: ProcessRequest,
): Promise<ProcessResponse> {
  return request(`/api/local/sessions/${encodeURIComponent(id)}/process`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function confirmProcess(
  id: string,
  processId: string,
  patch: { reply?: string; analysisSummary?: string },
): Promise<{ processId: string; analysisSummary: string }> {
  return request(
    `/api/local/sessions/${encodeURIComponent(id)}/process/${encodeURIComponent(processId)}/confirm`,
    {
      method: "POST",
      body: JSON.stringify(patch),
    },
  );
}

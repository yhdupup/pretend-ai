import type {
  ChatMessage,
  ClaimResponse,
  PollResponse,
  PreviewResponse,
  PublicSessionResponse,
} from "../../../src/shared/types";

// B 前端 API 封装。只允许调用 /api/public/* 路径（B 端 whitelist 中间件对其它路径统一 404）。
// B 页面与接口同源（隧道域名同时托管静态页和 API），因此沿用浏览器默认的 same-origin Cookie 发送策略，
// claim 拿到的参与者凭证不需要 credentials: "include" 也能回带。

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(res.status, (body && body.error) || "UNKNOWN_ERROR");
  }
  return (await res.json()) as T;
}

export function previewSession(id: string): Promise<PreviewResponse> {
  return request(`/api/public/sessions/${encodeURIComponent(id)}/preview`);
}

// 绑定是一次性的：同一条链接被第二个设备点开时会拿到 409 LINK_ALREADY_CLAIMED。
export function claimSession(id: string): Promise<ClaimResponse> {
  return request(`/api/public/sessions/${encodeURIComponent(id)}/claim`, {
    method: "POST",
  });
}

export function getSession(id: string): Promise<PublicSessionResponse> {
  return request(`/api/public/sessions/${encodeURIComponent(id)}`);
}

export function sendMessage(
  id: string,
  body: string,
): Promise<{ message: ChatMessage }> {
  // 每次发送生成新的 Idempotency-Key，防止网络重试导致同一条消息被重复创建；
  // 若用户短时间内重复点击发送同一内容，服务端仍会各自生成独立 key，不会被误判为幂等重放。
  const idempotencyKey =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return request(`/api/public/sessions/${encodeURIComponent(id)}/messages`, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ body }),
  });
}

export function pollMessages(
  id: string,
  after: string | null,
): Promise<PollResponse> {
  const query = after ? `?after=${encodeURIComponent(after)}` : "";
  return request(`/api/public/sessions/${encodeURIComponent(id)}/poll${query}`);
}

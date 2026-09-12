import { config } from "../server/config.js";
import type { ModelSettingsView } from "../shared/types.js";

/**
 * 模型访问凭证：只活在当前进程内存里（PRD §9.4）。
 *
 * - 不写 SQLite、不写 LocalStorage、不进 URL/命令行、不进日志、不进任何响应体；
 * - 启动时可以从环境变量读一份初值（本项目开发路径允许直接填 .env.example，
 *   这条与 §9.4 的偏离记在开发文档，发布前示例文件必须是空占位）；
 * - 进程退出即消失，不提供「记住凭证」（§9.4 末条：操作系统安全存储做完之前不提供）。
 */

export interface ModelCredentials {
  baseUrl: string;
  modelId: string;
  apiKey: string;
  source: "env" | "manual";
}

let current: ModelCredentials | null = null;

export function initCredentialsFromEnv(): void {
  if (current) return;
  if (!config.modelBaseUrl || !config.modelId || !config.modelApiKey) return;
  current = {
    baseUrl: config.modelBaseUrl,
    modelId: config.modelId,
    apiKey: config.modelApiKey,
    source: "env",
  };
}

export function getCredentials(): ModelCredentials | null {
  return current;
}

/** 三项中缺哪一项 —— 界面要能指名道姓，不能说成「没配密钥」。 */
export type ModelField = "baseUrl" | "modelId" | "apiKey";

export interface ModelDraft {
  baseUrl?: string;
  modelId?: string;
  apiKey?: string;
}

/**
 * 把「界面上框里填的」叠到「内存里已存的」之上，只算不写。
 *
 * 为什么要有这一步（2026-09-13 实跑）：「连通性测试」以前只测内存里那套，
 * 而「保存」在三项不齐时故意保持旧值不动 —— 于是屏幕上写着用户刚填的地址、
 * 测的却是上一次保存的地址，报出来的错在用户看来“不是他干的”。
 * 现在测试可以带框里的值，并且响应里回显本次到底打的是哪个地址。
 */
export function resolveDraft(patch: ModelDraft): {
  credentials: ModelCredentials | null;
  missing: ModelField[];
} {
  const base = current ?? {
    baseUrl: "",
    modelId: "",
    apiKey: "",
    source: "manual" as const,
  };
  const next: ModelCredentials = {
    baseUrl: (patch.baseUrl ?? base.baseUrl).trim().replace(/\/+$/, ""),
    modelId: (patch.modelId ?? base.modelId).trim(),
    // 空字符串/未填 = 不改这一项（前端读不回明文，提交时通常留空）；显式传值才覆盖。
    apiKey: patch.apiKey === undefined ? base.apiKey : patch.apiKey.trim(),
    source: "manual",
  };
  const missing: ModelField[] = [];
  if (!next.baseUrl) missing.push("baseUrl");
  if (!next.modelId) missing.push("modelId");
  if (!next.apiKey) missing.push("apiKey");
  return { credentials: missing.length === 0 ? next : null, missing };
}

/** 缺项的人话名字，给界面和错误文案共用。 */
export function missingText(missing: ModelField[]): string {
  const names: Record<ModelField, string> = {
    baseUrl: "服务地址",
    modelId: "模型名",
    apiKey: "密钥",
  };
  return missing.map((f) => names[f]).join("、") || "配置项";
}

/** 三项配齐才生效；配不齐时**保持原凭证不动**（改个地址不该顺手把 key 清了），
 *  但要把缺的是哪几项回报给界面 —— 只回一个 boolean 的话，A 看不出分叉在哪。 */
export function setCredentials(patch: ModelDraft): {
  accepted: boolean;
  missing: ModelField[];
} {
  const { credentials, missing } = resolveDraft(patch);
  if (!credentials) return { accepted: false, missing };
  current = credentials;
  return { accepted: true, missing: [] };
}

export function clearCredentials(): void {
  current = null;
}

/** 给 /api/local/settings 的可读视图：永不含密钥（§25.8）。 */
export function credentialsView(): Pick<
  ModelSettingsView,
  "baseUrl" | "modelId" | "hasKey" | "keySource"
> {
  return {
    baseUrl: current?.baseUrl ?? "",
    modelId: current?.modelId ?? "",
    hasKey: !!current,
    keySource: current?.source ?? null,
  };
}

/** 兜底脱敏：任何要往外走的文本都先把密钥抹掉（日志、错误消息、A 端提示共用）。 */
export function redactSecrets(text: string): string {
  if (!current?.apiKey) return text;
  return text.split(current.apiKey).join("***");
}

// 统一日志封装。PRD §18.6：只允许记录时间/请求ID/错误码/隧道状态/耗时等字段，
// 禁止记录消息正文、会话ID、Cookie、Authorization、模型凭证等。
// 调用方必须通过 meta 传入允许字段，禁止把整个请求体/敏感对象丢进来。

import { config } from "./config.js";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

interface AllowedMeta {
  requestId?: string;
  errorCode?: string;
  durationMs?: number;
  tunnelStatus?: string;
  // 只允许 "proxy" / "direct:<原因>"：隧道探活走没走系统代理。代理地址本身一律不落日志。
  probeMode?: string;
  // ---------- 隧道客户端的失败形状（阶段五补，PRD §18.6 白名单内）----------
  // 这三个字段是为了回答「为什么第一次必失败」而加的。此前这里什么都不记，
  // 线上唯一能看到的是一句中文「隧道客户端已退出」，查不下去，只能手跑复现。
  // 安全性：全是数值/布尔，不含域名、不含第三方 stderr 原文（原文里会有公网域名）。
  tunnelExitCode?: number | null;
  tunnelExitSignal?: string | null;
  tunnelSawUrl?: boolean;
  /** 探活失败的类型码（DNS / PROXY / TIMEOUT / HTTP_1033…）。只有类型，没域名。 */
  tunnelProbeError?: string | null;
  // ---------- 「A 发了链接、B 到没到」这一串（用户要求：这条链必须查得出来）----------
  /** created = A 新建了一个窗口；opened = 有人打开了 /s/<id> 页面。 */
  linkEvent?: "created" | "opened";
  /** 链接基址来源：tunnel / config / local-dev。local-dev 意味着这条只能自己电脑上点。 */
  linkSource?: string;
  /**
   * 为什么拿不到公网基址（只在 linkSource=local-dev 时有意义）：
   *   none     —— 逆道上根本没地址（未开 / 还在起 / 已收手）
   *   pending  —— 地址已经分到了，只是本机还没验证通过
   * 不区分这两格的话，日志上「再等几秒」和「逆道炸了」长得一模一样。
   */
  linkAddr?: "none" | "pending";
  /**
   * 会话 id 的前 8 位，用来把「A 创建了」和「B 打开了」两行对上。
   * 为什么只记前 8 位：完整 UUID 本身就是开门凭据（拿到就能当 B）， whole 条进日志等于
   * 把可用链接拄到日志里；前 8 位（32 bit）拼不出完整地址，既不破坏不可枚举性，
   * 又足以在一堆日志里认出“是同一条链接”。档3 第 13 条“日志里不含会话 UUID”仍成立。
   */
  linkRef?: string;
  path?: string;
  method?: string;
  status?: number;
  // ---------- 阶段4（PRD §9.4 §18.6）----------
  // 白名单只放“机制维度”，不放内容维度：
  // 正文、草稿、摘要、提示词、Skill 指令文本、上游响应体都不在可记字段里，写也写不进来。
  stage?: string; // assist | model | skill
  mode?: string; // manual | rules | user_model
  feature?: string; // AI_STYLE | ANALYSIS_SUMMARY
  /** 生成结果字数（不含内容）。 */
  charsOut?: number;
  /**
   * 输出预算调整前后的值（纯数值，不含内容）。
   * 推理模型把正文咬空时靠这两格回答「换大预算重试过没有、换到了哪一档」。
   */
  fromTokens?: number;
  toTokens?: number;
  /** 本次调用是否换过更大的输出预算。 */
  escalated?: boolean;
  /** 只含请求路径（如 /v1/chat/completions/chat/completions），不含主机名与任何凭证。 */
  endpointPath?: string;
  /** 失败响应「像什么」的分类标签（empty/html/text/json），不含任何内容。 */
  bodyKind?: string;
  /** 只记“有没有配好”，不记值。 */
  hasKey?: boolean;
  /** 保存这一项生效了没（只记布尔，不记任何值）。 */
  accepted?: boolean;
  /** 缺的是哪几项：只会是 baseUrl/modelId/apiKey 这几个字段名，不含值。 */
  missing?: string;
}

function shouldLog(level: LogLevel): boolean {
  const configured =
    (config.logLevel as LogLevel) in LEVEL_ORDER
      ? (config.logLevel as LogLevel)
      : "info";
  return LEVEL_ORDER[level] >= LEVEL_ORDER[configured];
}

function emit(level: LogLevel, entry: string, meta?: AllowedMeta): void {
  if (!shouldLog(level)) return;
  const line = {
    time: new Date().toISOString(),
    level,
    msg: entry,
    ...meta,
  };
  const out =
    level === "error"
      ? console.error
      : level === "warn"
        ? console.warn
        : console.log;
  out(JSON.stringify(line));
}

export const logger = {
  debug: (msg: string, meta?: AllowedMeta) => emit("debug", msg, meta),
  info: (msg: string, meta?: AllowedMeta) => emit("info", msg, meta),
  warn: (msg: string, meta?: AllowedMeta) => emit("warn", msg, meta),
  error: (msg: string, meta?: AllowedMeta) => emit("error", msg, meta),
};

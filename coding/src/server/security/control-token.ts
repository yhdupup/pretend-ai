import crypto from "node:crypto";
import { fromShellEnv } from "../config.js";

// 本机控制令牌（PRD §12.3 / 技术适配声明 §5）。
// - 进程启动时生成一次，只保存在内存中；进程退出即随之消失，不落盘、不写日志。
// - ≥128 位随机（这里用 256 位，即 32 字节）。
// - 通过一次性 bootstrap 兑换（POST /api/local/bootstrap/:token）换成 HttpOnly Cookie；
//   兑换成功后该令牌本身不再可用于再次兑换（防止令牌通过浏览器历史/日志泄露后被重放兑换），
//   但已发出的 Cookie 在进程存活期间持续有效，由 local-auth 中间件逐请求校验。

const TOKEN_BYTES = 32;

export const CONTROL_COOKIE_NAME = "aiwindow_ctrl";

// 显式配了 LOCAL_CONTROL_TOKEN_SECRET（≥16 字符）时，用它当控制令牌。
// 原因：阶段5 才有「启动器自动打开 /bootstrap/:token」，阶段1~4 开发者没有任何途径拿到随机令牌，
// A 前端根本打不开。所以非 production 下这个键直接生效（开发期方便）；
// production 下必须同时由启动器从 shell 环境注入 AIWINDOW_LAUNCHER_TOKEN=1 才生效，见下面的判定。
function devTokenFromEnv(): string | null {
  const raw = (process.env.LOCAL_CONTROL_TOKEN_SECRET ?? "").trim();
  if (raw.length < 16) return null;
  if (process.env.NODE_ENV !== "production") return raw;
  // 生产模式下这条路的唯一合法来源是阶段5 的启动器：它把一次性令牌写在**子进程环境变量**里，
  // 并显式声明 AIWINDOW_LAUNCHER_TOKEN=1。两个键都必须来自 shell 环境而不是 .env 文件，
  // 否则「谁在 .env.local 里手写一个固定令牌」就能把 PRD §12.3「每次启动随机」变成摆设。
  return process.env.AIWINDOW_LAUNCHER_TOKEN === "1" &&
    fromShellEnv("AIWINDOW_LAUNCHER_TOKEN") &&
    fromShellEnv("LOCAL_CONTROL_TOKEN_SECRET")
    ? raw
    : null;
}

// 令牌惰性生成：本模块可能在 config.ts 里的 dotenv 之前被 import，进模块就读 env 会拿到 undefined。
let cachedToken: string | null = null;
let usingEnvToken = false;

function token(): string {
  if (cachedToken === null) {
    const env = devTokenFromEnv();
    usingEnvToken = env !== null;
    cachedToken = env ?? crypto.randomBytes(TOKEN_BYTES).toString("hex");
  }
  return cachedToken;
}

/** 供启动日志提示：当前是否在使用环境变量里的开发令牌（不回传令牌本身）。 */
export function isUsingEnvControlToken(): boolean {
  token();
  return usingEnvToken;
}

let bootstrapConsumed = false;

/** 仅供同进程内部（路由/中间件/测试）读取，绝不能经由 logger 或 HTTP 响应体回传给客户端。 */
export function getControlToken(): string {
  return token();
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // 长度不同直接判负，但仍做一次等长比较，避免因提前返回引入明显的时序差异。
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * 尝试用候选令牌完成一次性 bootstrap 兑换。
 * 成功后令牌被标记为已消费，后续再用同一令牌兑换会失败（即便字符串仍然匹配）。
 */
export function consumeBootstrap(candidate: string): boolean {
  if (bootstrapConsumed) return false;
  if (!timingSafeEqualStr(candidate, token())) return false;
  bootstrapConsumed = true;
  return true;
}

/** 校验某个字符串是否等于当前控制令牌（用于中间件校验 Cookie 值），不消费一次性标记。 */
export function isValidControlToken(
  candidate: string | undefined | null,
): boolean {
  if (!candidate) return false;
  return timingSafeEqualStr(candidate, token());
}

/** 仅供测试重置内部状态（生产代码不应调用）。 */
export function __resetBootstrapConsumedForTests(): void {
  bootstrapConsumed = false;
}

import { describe, expect, it, beforeEach } from "vitest";
import {
  consumeBootstrap,
  getControlToken,
  isUsingEnvControlToken,
  isValidControlToken,
  __resetBootstrapConsumedForTests,
} from "../src/server/security/control-token";

// 控制令牌（PRD §12.3）。开发期允许用 LOCAL_CONTROL_TOKEN_SECRET 固定令牌，否则每次启动随机，
// 这里锁两条底线：令牌强度够、bootstrap 只能兑换一次。

describe("control token", () => {
  beforeEach(() => {
    __resetBootstrapConsumedForTests();
  });

  it("is at least 128 bits when randomly generated", () => {
    if (isUsingEnvControlToken()) {
      // 开发者自己设了固定令牌，强度由 .env 负责，不在此断言
      return;
    }
    expect(getControlToken().length).toBeGreaterThanOrEqual(32);
    expect(/^[0-9a-f]+$/.test(getControlToken())).toBe(true);
  });

  it("validates the right token and rejects unknown ones", () => {
    expect(isValidControlToken(getControlToken())).toBe(true);
    expect(isValidControlToken("nope")).toBe(false);
    expect(isValidControlToken(undefined)).toBe(false);
  });

  it("allows only the first bootstrap exchange", () => {
    expect(consumeBootstrap(getControlToken())).toBe(true);
    // 兑换成功后同一令牌不能再兑换一次（防浏览器历史/日志泄露后重放）
    expect(consumeBootstrap(getControlToken())).toBe(false);
    expect(consumeBootstrap("nope")).toBe(false);
    // 但已签发的 Cookie 仍然有效，由 isValidControlToken 判断
    expect(isValidControlToken(getControlToken())).toBe(true);
  });
});

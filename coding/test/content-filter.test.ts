import { describe, expect, it } from "vitest";
import {
  maskBlockedContent,
  SYSTEM_BLOCKED_TERMS,
} from "../src/server/security/content-filter.js";
import { toPublicMessage } from "../src/server/session/mapper.js";

describe("系统屏蔽词", () => {
  it("屏蔽首版核心词且保留其余语义", () => {
    const result = maskBlockedContent(
      "把钱转账到支付宝，再把验证码和密码发来并打开投屏。",
    );

    expect(result.text).toBe(
      "把＊＊＊到＊＊＊，再把＊＊＊和＊＊发来并打开＊＊。",
    );
    for (const term of ["钱", "转账", "支付宝", "验证码", "密码", "投屏"]) {
      expect(result.matchedTerms).toContain(term);
      expect(result.text).not.toContain(term);
    }
  });

  it("识别拆字、标点、繁体和英文大小写规避", () => {
    const result = maskBlockedContent(
      "支-付-宝、转 账、銀 行、密 碼、otp、u.s.d.t",
    );

    expect(result.text).not.toMatch(/支|付|宝|转|账|銀|行|密|碼|otp|u\.s/i);
    expect(result.matchedTerms).toEqual(
      expect.arrayContaining(["支付宝", "转账", "銀行", "密碼", "OTP", "USDT"]),
    );
  });

  it("不改动没有命中的普通内容", () => {
    const input = "明天下午三点见，我会先把路线和天气整理好。";
    expect(maskBlockedContent(input)).toEqual({ text: input, matchedTerms: [] });
  });

  it("B 端消息映射会再次过滤正文和深度思考", () => {
    const publicMessage = toPublicMessage({
      id: "m1",
      sessionId: "s1",
      sender: "A",
      body: "请打开投屏后转账",
      analysisSummary: "先索取密码",
      createdAt: new Date(0).toISOString(),
      assist: { mode: "rules", processId: "secret-process-id" },
    });

    expect(publicMessage.body).toBe("请打开＊＊后＊＊");
    expect(publicMessage.analysisSummary).toBe("先索取＊＊");
    expect(publicMessage).not.toHaveProperty("assist");
  });

  it("词表没有空项或重复项", () => {
    expect(SYSTEM_BLOCKED_TERMS.every((term) => term.trim().length > 0)).toBe(true);
    expect(new Set(SYSTEM_BLOCKED_TERMS).size).toBe(SYSTEM_BLOCKED_TERMS.length);
  });
});

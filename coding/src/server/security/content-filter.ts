/**
 * B 端系统屏蔽词。
 *
 * 这里优先收录与诈骗中的资金索取、凭证套取、远程操控直接相关的词，
 * 不做违法内容的无限枚举。修改时同步更新 docs/系统屏蔽词规范.md。
 */
export const SYSTEM_BLOCKED_TERMS = [
  // 资金、支付与账户
  "支付宝",
  "支付寶",
  "微信支付",
  "银行",
  "銀行",
  "银行卡",
  "銀行卡",
  "网银",
  "網銀",
  "信用卡",
  "转账",
  "轉賬",
  "轉帳",
  "汇款",
  "匯款",
  "收款码",
  "收款碼",
  "付款码",
  "付款碼",
  "代付",
  "充值",
  "提现",
  "提現",
  "手续费",
  "手續費",
  "保证金",
  "保證金",
  "押金",
  "垫付",
  "墊付",
  "刷单",
  "刷單",
  "返利",
  "贷款",
  "貸款",
  "借款",
  "红包",
  "紅包",
  "钱",
  "錢",

  // 密码、身份与验证凭证
  "支付密码",
  "支付密碼",
  "登录密码",
  "登錄密碼",
  "密码",
  "密碼",
  "验证码",
  "驗證碼",
  "动态码",
  "動態碼",
  "短信码",
  "短信碼",
  "卡号",
  "卡號",
  "身份证",
  "身份證",
  "身份信息",
  "OTP",
  "PIN",
  "CVV",

  // 远程操控与常见诈骗话术
  "投屏",
  "屏幕共享",
  "远程控制",
  "遠程控制",
  "远程协助",
  "遠程協助",
  "安全账户",
  "安全賬戶",
  "解冻账户",
  "解凍賬戶",
  "涉嫌洗钱",
  "涉嫌洗錢",
  "配合调查",
  "配合調查",
  "内幕消息",
  "內幕消息",
  "稳赚不赔",
  "穩賺不賠",
  "高额回报",
  "高額回報",
  "USDT",
] as const;

export interface ContentFilterResult {
  text: string;
  /** 去重后的命中项。只供 A 端反馈和测试使用，不写日志。 */
  matchedTerms: string[];
}

const BETWEEN_CHARS = "[\\s\\p{P}\\p{S}_]*";

function escapeRegex(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function patternFor(term: string): RegExp {
  return new RegExp(
    Array.from(term).map(escapeRegex).join(BETWEEN_CHARS),
    "giu",
  );
}

const RULES = [...SYSTEM_BLOCKED_TERMS]
  .sort((a, b) => Array.from(b).length - Array.from(a).length)
  .map((term) => ({ term, pattern: patternFor(term) }));

/**
 * 将命中词整体替换为全角星号；同时覆盖“转 账”“支-付-宝”等简单拆字规避。
 * 不改变未命中的文本，也不记录原文。
 */
export function maskBlockedContent(input: string): ContentFilterResult {
  let text = input;
  const matchedTerms: string[] = [];

  for (const { term, pattern } of RULES) {
    pattern.lastIndex = 0;
    if (!pattern.test(text)) continue;
    matchedTerms.push(term);
    pattern.lastIndex = 0;
    text = text.replace(pattern, "＊".repeat(Array.from(term).length));
  }

  return { text, matchedTerms };
}

import { createHash } from "node:crypto";
import { config } from "../server/config.js";
import type { AssistRawResult, StyleLevel } from "../shared/types.js";

/**
 * 输出校验（PRD §9.5 末段 + §8.3）：模型返回与本地规则产出的内容都要过同一套闸。
 * 任一不过 → A 编辑区一个字符都不改，给出「哪一项被拦下」的具体原因。
 */

/**
 * 摘要里不能出现的内部机制/操作者身份词（取自「深度思考反推」Skill 的边界条款）。
 * 这段文字会被 B 直接读到，所以「草稿/轮次/模型/密钥」这类词一露出来就是穿帮。
 */
export const BANNED_TERMS = [
  "草稿",
  "候选",
  "系统提示",
  "思维链",
  "提示词",
  "模型",
  "api",
  "密钥",
  "档位",
  "轮次",
  "倒计时",
  "后台",
  "规则模式",
  "skill",
  "token",
  "prompt",
  "我是ai",
  "作为ai",
  "语言模型",
] as const;

/**
 * 对话性质泄露：摘要里出现「AI / 人工智能 / 真人 / 扮演」这类词，等于当场把这场玩笑戳破
 * （PRD §2.2 的核心体验、§8.3 的泄露面收口）。用词边界匹配，避免误伤 topic 里的普通英文。
 */
const IDENTITY_LEAKS: Array<{ label: string; test: RegExp }> = [
  { label: "ai", test: /(^|[^a-z])ai([^a-z]|$)/i },
  { label: "人工智能", test: /人工智能/ },
  { label: "真人", test: /真人|活人/ },
  { label: "扮演", test: /扮演|假装/ },
  { label: "人工", test: /人工/ },
];

/**
 * 改写允许的正文长度上限：**同时**卡「+固定余量」和「×倍率」，取严的那个。
 * 取宽会留出空子：6 字的「在的，刚看到」被撑成 68 字（还把上一轮的内容复述一遍），
 * 加长草稿却只加 80 字又太松，所以两条都要成立。与「增加 AI 味」Skill 第 18 行
 * 「保持原文信息量和长度大致相当」同向。
 */
/**
 * 场景标签的合法取值：两份 Skill 各自的六类（增加 AI 味按文体分：短句/结论/职场汇报/客服回复/科普/网文；
 * 深度思考反推按问题类型分：决策/解释/多轮追问/安抚客服/信息不足/方案对比）。
 * 这个标签只给 A 看，模型爱怎么写是它的事，界面不能出现「旅行建议」这种没定义的东西 —— 不认识就归 null。
 */
export const SCENE_LABELS = [
  "短句",
  "结论",
  "职场汇报",
  "客服回复",
  "科普",
  "网文",
  "决策",
  "解释",
  "多轮追问",
  "安抚客服",
  "信息不足",
  "方案对比",
] as const;

const SCENE_ALIASES: Record<string, string> = {
  安抚: "安抚客服",
  客服: "客服回复",
  追问: "多轮追问",
  对比: "方案对比",
  科普解释: "科普",
  汇报: "职场汇报",
};

export function normalizeScene(raw: string | null | undefined): string | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const labels = SCENE_LABELS as readonly string[];
  if (labels.includes(text)) return text;
  if (SCENE_ALIASES[text]) return SCENE_ALIASES[text];
  // 「场景：决策类」这种带尾巴的输出，能唯一对上就收，对不上多个一律不要。
  const hits = labels.filter((label) => text.includes(label));
  return hits.length === 1 ? hits[0] : null;
}

export function growthCeiling(draftChars: number): number {
  return Math.max(
    draftChars,
    Math.min(
      draftChars + config.maxReplyGrowthChars,
      Math.ceil(draftChars * config.maxReplyGrowthRatio),
    ),
  );
}

/**
 * 找「别人塞进来的用词」：命中了内部用词或身份词，但这段词并不在 A 的草稿里。
 * A 自己写「这个模型不行」是他的自由；改写阶段模型自己冒出「提示词」「密钥」就是穿帮。
 */
export function findForeignTerm(text: string, origin: string): string | null {
  const hay = text.toLowerCase();
  const base = (origin ?? "").toLowerCase();
  for (const term of BANNED_TERMS) {
    if (hay.includes(term.toLowerCase()) && !base.includes(term.toLowerCase()))
      return term;
  }
  for (const leak of IDENTITY_LEAKS) {
    if (leak.test.test(text) && !leak.test.test(origin ?? ""))
      return leak.label;
  }
  return null;
}

/** 摘要里露出对话性质的词；返回命中的词，没命中返回 null。 */
export function findIdentityLeak(text: string): string | null {
  for (const leak of IDENTITY_LEAKS) {
    if (leak.test.test(text)) return leak.label;
  }
  return null;
}

const MARKDOWN_PATTERNS: Array<{ label: string; test: RegExp }> = [
  { label: "Markdown 标题", test: /(^|\n)\s{0,3}#{1,6}\s/ },
  { label: "Markdown 列表", test: /(^|\n)\s*[-*+]\s/ },
  { label: "Markdown 加粗/斜体", test: /\*\*|__|~~/ },
  { label: "引用块", test: /(^|\n)\s*>\s/ },
  { label: "代码块或行内代码", test: /```|`/ },
  { label: "链接", test: /\[[^\]]*\]\([^)]*\)/ },
  { label: "HTML 标签", test: /<\/?[a-zA-Z][^>]*>/ },
  { label: "表格分隔", test: /(^|\n)\s*\|.*\|/ },
];

/**
 * 去掉「1、」「2)」「第三」这类**编号标记**，避免把改写产生的序号当成新增事实。
 * 必须覆盖行中位置：规则模式的「浓郁」档用「；」把编号项串成一整段，
 * 只处理行首会让校验器把「2、3、」误判成凭空多出来的数字，把自己产出的正文整条拦死。
 * `(?!\d)` 是为了不吃掉「12.5」这种真数值。
 */
export function stripEnumerationMarkers(text: string): string {
  return text
    .replace(/(^|\n|[；;。，,：:])\s*[（(]?\d{1,2}[）)、.．](?!\d)\s*/g, "$1")
    .replace(
      /(^|\n|[；;。，,：:])\s*[（(]?[一二三四五六七八九十]{1,3}[）)、.．](?!\d)\s*/g,
      "$1",
    );
}

/** 抽取阿拉伯数字及其紧跟的单位，用于事实保持校验（数字级，做不到语义级）。 */
export function extractNumbers(text: string): string[] {
  const stripped = stripEnumerationMarkers(text);
  return (
    stripped.match(
      // 连单位一起取：只看数字会把「5 万」和「5 日」当成同一个事实，改写时挪动单位就检不出来。
      /\d+(?:[.,]\d+)?\s*(?:%|％|万|亿|元|块|角|分钟|秒|小时|天|周|月|年|号|点|岁|折|倍|条|件|台|张|遍|次|个|位|人|米|公里|kb|mb|gb|k|m)?/gi,
    ) ?? []
  ).map((n) => n.replace(/\s+/g, "").toLowerCase());
}

export function containsBannedTerm(text: string): string | null {
  const haystack = text.toLowerCase();
  for (const term of BANNED_TERMS) {
    if (haystack.includes(term.toLowerCase())) return term;
  }
  return null;
}

export function findMarkdownStructure(text: string): string | null {
  for (const pattern of MARKDOWN_PATTERNS) {
    if (pattern.test.test(text)) return pattern.label;
  }
  return null;
}

export function charLength(text: string): number {
  // 按码点计：emoji 和生僻字在 UTF-16 里是两个元素，用 .length 会误杀。
  return [...text].length;
}

/** 模型很爱回 ```json 包裹的对象；先剥掉围栏再解析，别把围栏当成格式错误。 */
export function parseStructured(raw: string): Partial<AssistRawResult> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = (fenced ? fenced[1] : raw).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(candidate.slice(start, end + 1));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    return parsed as Partial<AssistRawResult>;
  } catch {
    return null;
  }
}

/** 把模型返回的自由文本当成正文（只做「增加 AI 味」时，Skill 本身就允许直接给文本）。 */
export function asRawResult(
  partial: Partial<AssistRawResult> | null,
  fallbackReply: string,
  styleLevel: StyleLevel,
): AssistRawResult {
  const str = (value: unknown) => (typeof value === "string" ? value : "");
  const warnings = Array.isArray(partial?.warnings)
    ? partial.warnings.filter((w): w is string => typeof w === "string")
    : [];
  return {
    reply: str(partial?.reply) || fallbackReply,
    analysis_summary: str(partial?.analysis_summary),
    style_level: str(partial?.style_level) || styleLevel,
    scene: str(partial?.scene),
    warnings,
  };
}

export interface OutputCheckInput {
  /** 校验对象：候选正文（rewrite/both）或摘要（analysis）。 */
  text: string;
  kind: "reply" | "analysis";
  /** 事实比对的基准：正文比 A 草稿，摘要比候选正文（摘要允许没有数字）。 */
  sourceText: string;
  draft: string;
  /**
   * 跳过涨幅闸。只给本地规则模式用：它的「明显/浓郁」本来就要把短句撑成模板句，
   * 涨幅闸是为「模型替 A 回答问题」设计的，对确定性模板没有意义（禁词与事实照旧卡）。
   */
  skipGrowth?: boolean;
}

export interface OutputCheckFailure {
  code: "INVALID_MODEL_OUTPUT";
  reason: string;
}

export type OutputCheckResult =
  { ok: true } | { ok: false; failure: OutputCheckFailure };

/** §9.5：长度、纯文本、事实保持、禁词。 */
export function checkOutputText(input: OutputCheckInput): OutputCheckResult {
  const limit =
    input.kind === "reply" ? config.maxReplyChars : config.maxAnalysisChars;
  if (!input.text.trim()) {
    return {
      ok: false,
      failure: {
        code: "INVALID_MODEL_OUTPUT",
        reason: `${label(input.kind)}是空的`,
      },
    };
  }
  if (charLength(input.text) > limit) {
    return {
      ok: false,
      failure: {
        code: "INVALID_MODEL_OUTPUT",
        reason: `${label(input.kind)}有 ${charLength(input.text)} 字，超过 ${limit} 字上限`,
      },
    };
  }
  const markdown = findMarkdownStructure(input.text);
  if (markdown) {
    return {
      ok: false,
      failure: {
        code: "INVALID_MODEL_OUTPUT",
        reason: `${label(input.kind)}里出现了${markdown}，只能纯文本`,
      },
    };
  }
  if (/\r?\n\s*\r?\n/.test(input.text) && input.kind === "analysis") {
    return {
      ok: false,
      failure: {
        code: "INVALID_MODEL_OUTPUT",
        reason: "分析摘要里有空行分段，看起来不像一段自然思路",
      },
    };
  }
  // 禁词只卡分析摘要：正文是 A 自己写的（他说「这个模型不行」不该被拦），
  // 而摘要是系统生成给 B 看的东西，露出「草稿/轮次/模型」就是穿帮（Skill 边界条款）。
  if (input.kind === "analysis") {
    const banned = containsBannedTerm(input.text);
    if (banned) {
      return {
        ok: false,
        failure: {
          code: "INVALID_MODEL_OUTPUT",
          reason: `分析摘要里露出了内部用词「${banned}」，会被对方看穿`,
        },
      };
    }
    const leak = findIdentityLeak(input.text);
    if (leak) {
      return {
        ok: false,
        failure: {
          code: "INVALID_MODEL_OUTPUT",
          reason: `分析摘要里出现了「${leak}」，会当场暴露这段对话的性质`,
        },
      };
    }
  }
  if (input.kind === "reply") {
    // 正文是给 B 看的最终产物：即使它出自「改写」这一路，也不能带进 A 没写过的内部用词。
    // 真模型被 B 的提问带跑时会自己讲「提示词属于内部配置」，这种话一发出去整场就穿帮了。
    const foreign = findForeignTerm(input.text, input.draft);
    if (foreign) {
      return {
        ok: false,
        failure: {
          code: "INVALID_MODEL_OUTPUT",
          reason: `改写带进了你草稿里没有的用词「${foreign}」，这种话不能发给对方`,
        },
      };
    }
    // 改写不是替我回答：篇幅涨过上限基本就是模型在自作主张写作文。
    const draftChars = charLength(input.draft);
    if (
      !input.skipGrowth &&
      draftChars > 0 &&
      charLength(input.text) > growthCeiling(draftChars)
    ) {
      return {
        ok: false,
        failure: {
          code: "INVALID_MODEL_OUTPUT",
          reason: `改写后从 ${draftChars} 字涨到 ${charLength(input.text)} 字，模型在替你回答问题了`,
        },
      };
    }
    const facts = factDiff(input.sourceText, input.text);
    if (facts.added.length) {
      return {
        ok: false,
        failure: {
          code: "INVALID_MODEL_OUTPUT",
          reason: `改写后凭空多了数字「${facts.added.join("、")}」，不能替你造事实`,
        },
      };
    }
    if (facts.missing.length) {
      return {
        ok: false,
        failure: {
          code: "INVALID_MODEL_OUTPUT",
          reason: `改写后你原文里的「${facts.missing.join("、")}」不见了`,
        },
      };
    }
  }
  return { ok: true };
}

function label(kind: "reply" | "analysis"): string {
  return kind === "reply" ? "回复正文" : "分析摘要";
}

export function factDiff(
  source: string,
  candidate: string,
): { added: string[]; missing: string[] } {
  const sourceNumbers = extractNumbers(source);
  const candidateNumbers = extractNumbers(candidate);
  const sourceBag = new Map<string, number>();
  for (const n of sourceNumbers) sourceBag.set(n, (sourceBag.get(n) ?? 0) + 1);
  const candidateBag = new Map<string, number>();
  for (const n of candidateNumbers)
    candidateBag.set(n, (candidateBag.get(n) ?? 0) + 1);

  const added: string[] = [];
  const missing: string[] = [];
  for (const [n, count] of candidateBag) {
    const before = sourceBag.get(n) ?? 0;
    if (count > before) added.push(n);
    if (before > count) missing.push(n);
  }
  for (const n of sourceBag.keys()) if (!candidateBag.has(n)) missing.push(n);
  return { added: [...new Set(added)], missing: [...new Set(missing)] };
}

/** A 手改摘要后的内容也要过同一套闸（PRD §6.6 允许「编辑并确认摘要」）。 */
export function checkManualAnalysis(text: string): OutputCheckResult {
  return checkOutputText({
    text,
    kind: "analysis",
    sourceText: text,
    draft: text,
  });
}

/** 一致性校验用的内容哈希（PRD §6.6「A 改过正文就要重新确认摘要」）。 */
export function hashText(value: string): string {
  // 长度前缀分隔：避免 "ab"+"c" 与 "a"+"bc" 拼出同一个串。
  return createHash("sha256").update(`${value.length}\0${value}`).digest("hex");
}

import { charLength, containsBannedTerm, findIdentityLeak } from "./validate.js";
import type { StyleLevel } from "../shared/types.js";

/**
 * 本地规则模式（PRD §9.1「只执行项目代码内置的确定性规则，不读取或调用 Skill 文件」）。
 *
 * 设计约束：
 * - 只做表面变换。所有规则都是「模板 + 原文片段」拼接，原文整句保留 ——
 *   事实保持由**构造**保证，再由 §4.6 校验器当第二道闸。
 * - 不新增数字、时间、实体、来源、承诺；不删原文任何一句；不动否定与情态位置。
 * - 摘要遵守「深度思考反推」Skill 的正文长度封顶表（≤8 字不生成）。
 *
 * 已知局限（写进开发文档 §九）：规则模式的「AI 味」明显弱于模型模式，观感好坏要人判断。
 */

/** 正文长度决定摘要硬顶（与「深度思考反推」Skill 的封顶表一致；再与 maxAnalysisChars 取小的）。
 *
 * 2026-09-12 两次改过：
 * - 上一轮把模板拆成可退档的零件，但表本身没动（60/100/160/240）；
 * - 这一轮作者反馈「太短了，而且没有逻辑」：60 字只装得下两句，两句之间看不出推导关系。
 *   所以把档位抬高，同时把链路从「四句并列」改成「六步推导 + 原话锁定」。
 * 抬高是有界的：最深一档 300 字，跟 maxAnalysisChars 默认值持平，不会出现“摘要比正文长十倍”。
 * ≤8 字不生成这一档保留（语气词反推不出思路）。 */
export function analysisCapByLength(textLength: number): number {
  if (textLength <= 8) return 0;
  if (textLength <= 30) return 120; // 装得下「锁定 + 定性 + 推导 + 收束」四步
  if (textLength <= 60) return 170; // 五步到六步
  if (textLength <= 150) return 240; // 整条六步 + 锁定（最长一档 187）
  return 300;                        // 与 maxAnalysisChars 默认值持平
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？；!?;])/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 轻微：只做书写规范化 —— 补句末标点、压缩多余空白，不加任何词。 */
function lightTouch(text: string): string {
  const collapsed = text.replace(/[ \t]+/g, " ").trim();
  return /[。！？!?；;…]$/.test(collapsed) ? collapsed : `${collapsed}。`;
}

/** 明显档的开头引导语池子。只在整段最前面出现一次，绝不逐句加。
 *
 * 2026-09-12 作者反馈：「处理正文不要每句都带我这边的情况是：」。
 * 旧版把这一句当固定前缀，单句正文永远顶着一模一样的一句话，看多了反而不像人（人不会每次开口都说这句）。
 * 现在：① 只加在开头一处；② 多句时剩下的句子改用编号；③ 引导语按正文哈希从池子里选，
 * 同一段草稿重复点结果稳定（可测），不同草稿不会每次同一句。
 */
const LEAD_INS = [
  "先给结论：",
  "我这边的情况是：",
  "直接说结果：",
  "对齐一下：",
  "按你问的顺序：",
];

/** 浓郁档的固定开头（也用来识别「这句已经加工过了」）。 */
const HEAVY_HEAD = "我把这句拆开说：";

/** 开头已经带过引导语 / 浓郁档的头，就不再叠第二层：A 连点两次「处置正文」很常见，
 *  旧版会把上一轮的结果再加工一遍，套出「先给结论：我这边的情况是：……」。 */
function alreadyLed(text: string): boolean {
  return (
    LEAD_INS.some((lead) => text.startsWith(lead)) ||
    text.startsWith("结论：") ||
    text.startsWith(HEAVY_HEAD)
  );
}

function hashOf(text: string): number {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.codePointAt(0)! ) % 9973;
  return h;
}

/** 句末标点拿掉，给编号行用。 */
function bare(sentence: string): string {
  return sentence.replace(/[。！？；;!?…]$/u, "");
}

/**
 * 明显：结论先行 + 其余句子逐行编号。引导语不含判断词，不会把 A 的立场改方向。
 */
function structured(text: string): string {
  const body = lightTouch(text);
  if (alreadyLed(body)) return body;
  const sentences = splitSentences(body);
  const lead = LEAD_INS[hashOf(body) % LEAD_INS.length];
  if (sentences.length <= 1) return `${lead}${sentences[0] ?? body}`;
  const rest = sentences
    .slice(1)
    .map((s, i) => `${i + 1}、${bare(s)}。`)
    .join("\n");
  return `${lead}${bare(sentences[0])}。\n${rest}`;
}

/**
 * 浓郁：拆到小句逐行编号。
 *
 * 旧版只按整句拆，单句正文直接掉回 structured，三档里两档长得一模一样（看不出档位开了）。现在单句再按
 * 「，、；」拆一层：“可以，周五前给你。”就变成两行编号，那是 AI 最爱干的事 —— 把一句话拆成列表。
 * 拆完只剩一条时不拆，给一句「结论：」。不增词、不改字，只动排版。
 */
function heavy(text: string): string {
  const body = lightTouch(text);
  // 已经加工过（引导语开头，或整段就是编号列表）就原样返回，不要叠第二层
  if (alreadyLed(body) || /^[1-9]、/.test(body)) return body;
  let clauses = splitSentences(body).map(bare).filter(Boolean);
  if (clauses.length <= 1) {
    clauses = (clauses[0] ?? body)
      .split(/[，、；,;]/u)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (clauses.length <= 1) return `结论：${clauses[0] ?? body}。`;
  const lines = clauses.map((c, i) => `${i + 1}、${c}。`).join("\n");
  return `${HEAVY_HEAD}\n${lines}`;
}

export function rewriteByRules(draft: string, styleLevel: StyleLevel): string {
  const text = draft.trim();
  if (!text) return "";
  switch (styleLevel) {
    case "轻微":
      return lightTouch(text);
    case "浓郁":
      return heavy(text);
    case "明显":
    default:
      return structured(text);
  }
}

type Scene =
  "决策" | "解释" | "多轮追问" | "安抚客服" | "信息不足" | "方案对比";

function detectScene(question: string, reply: string): Scene {
  const q = question.trim();
  if (/(那如果|要是这样|你刚说|按你刚才)/.test(q)) return "多轮追问";
  if (/(抱歉|不好意思|别急|久等|理解你)/.test(reply)) return "安抚客服";
  if (/(对比|哪个好|选哪|比一下|两种方案|区别)/.test(q)) return "方案对比";
  if (/(为什么|怎么|是什么|如何|原理|差别)/.test(q)) return "解释";
  if (/(吗|能不能|可不可以|要不要|行不行|好不好)/.test(q)) return "决策";
  return "信息不足";
}

/**
 * 六步推导链（Skill §骨架：界定范围 → 排除 → 依据 → 推导 → 边界 → 收束）。
 *
 * 为什么不拿四句并列就交差：作者 2026-09-12 的话是「太短了，而且没有逻辑」。
 * 长度好改，“没逻辑”不好改 —— 原来的四句之间看不出谁推出谁，像四句各自成立的声明。
 * 现在每场最给六步，前一步是后一步的前提，用“所以 / 照这些条件推 / 检查一遍”连起来，
 * 并且第一句就把对方的原话钉住（下面 anchorStep）—— 钉不住就不是在说这件事，一看就是模板。
 *
 * 不引用正文里的事实（不插值 candidateReply），所以不会新增数字/实体/承诺；
 * 唯一的外来文本是对方自己那句话的开头，那是原样引用（Skill 只允许原样引用，不允许外推）。
 */
interface StepSet {
  frame: string;
  exclude: string;
  basis: string;
  derive: string;
  edge: string;
  close: string;
}

const STEPS: Record<Scene, StepSet> = {
  决策: {
    frame: "先定性：你问的是这件事行不行，不是要我改做法。",
    exclude: "所以我不回答“要不要做”，那是另一个问题。",
    basis: "依据只用你已经给出的时间和条件，没替你补新的。",
    derive: "照这些条件往下推，能落到的就是你看到的这一句。",
    edge: "做不到的那部分我原样留着，没说成做得到。",
    close: "检查一遍：结论没超出你的条件，也没加新的承诺。",
  },
  解释: {
    frame: "先分清你要的是原因，还是下一步的做法。",
    exclude: "所以没往原理深处铺，那一般不是你这一句要的。",
    basis: "依据挑跟你这件事直接相关的那一层。",
    derive: "照这一层往下说，就是你看到的这几句。",
    edge: "你问的如果是另一层，这版会偏，我再收紧。",
    close: "检查一遍：只解释，没有顺手替你改结论。",
  },
  多轮追问: {
    frame: "这一问接着上一问，我没重新起头。",
    exclude: "你已经确认过的条件当成前提，不再重复论证。",
    basis: "依据还是先前那套，只换了你刚改的那一处。",
    derive: "所以这版只回你这次改动带出来的差别。",
    edge: "两边说法对不上的地方，以这一条为准。",
    close: "检查一遍：没有把前面说过的话再讲一遍。",
  },
  安抚客服: {
    frame: "先把你现在的状态接住，再谈怎么办。",
    exclude: "所以没有顺手报时间点，那得看你已经说过什么。",
    basis: "依据是你实际等的那段时间，不往轻里说。",
    derive: "照这些往下给，就是你现在马上能做的动作。",
    edge: "超出这些的我不替你许愿。",
    close: "检查一遍：安慰的话没有变成新的承诺。",
  },
  方案对比: {
    frame: "先确认你实际在比哪几条路。",
    exclude: "所以没有替你加新的比较项。",
    basis: "依据按对你影响最大的维度排序。",
    derive: "照这个排下来，顺序就是你看到的这一版。",
    edge: "被放后面那条的代价我也留着，没抹掉。",
    close: "检查一遍：结论有倾向，但没说另一条完全不行。",
  },
  信息不足: {
    frame: "你给的条件还不够把结论定死。",
    exclude: "所以我没编一个前提把话说明白。",
    basis: "依据只能按最常见的情况先算一版。",
    derive: "算下来就是这一版：当暂时答案用，不当最终结论。",
    edge: "不确定的地方原样标着，你补一句我再收紧。",
    close: "检查一遍：把不确定的都留在不确定里了。",
  },
};

/**
 * 锁定对方原话做第一步。拿不到（太短/太长/带内部用词）就返回空串，整条链退回通用版。
 *
 * 只取第一句、拿掉标点、压到 24 字：不重写、不概括，所以不可能新增事实。
 * 对方的话按不可信输入处理：带了禁用词就不引，免得把提示注入原样贴回自己的“思考过程”里。
 */
export function anchorStep(question: string): string {
  const first = splitSentences(question.trim())[0] ?? "";
  const one = first.replace(/\s+/g, "");
  const n = charLength(one);
  if (n < 6 || n > 24) return "";
  if (containsBannedTerm(one)) return "";
  if (findIdentityLeak(one)) return "";
  return `先把问题钉住：你要的是「${one}」这件事的答复。`;
}

/** 封顶装得下几步就发几步：七步（带锁定）→ 六 → 五 → 四 → 三 → 兜底一句，不做半句截断。 */
export function stepTiers(scene: Scene, anchor: string): string[][] {
  const s = STEPS[scene];
  const withAnchor = (parts: string[]): string[] =>
    anchor ? [anchor, ...parts] : parts;
  return [
    withAnchor([s.frame, s.exclude, s.basis, s.derive, s.edge, s.close]),
    withAnchor([s.frame, s.exclude, s.basis, s.derive, s.close]),
    withAnchor([s.frame, s.basis, s.derive, s.close]),
    withAnchor([s.frame, s.derive, s.close]),
    withAnchor([s.frame, s.close]),
    [SHORT_FALLBACK],
  ];
}

/** 编号只在最后加：退档时编号永远是 1、2、3… 连着的，不会跳号（跳号一眼假）。 */
function numberSteps(steps: string[]): string {
  return steps.map((s, i) => `${i + 1}、${s}`).join("\n");
}

function fits(steps: string[], cap: number): boolean {
  return charLength(numberSteps(steps)) <= cap;
}

const SHORT_FALLBACK = `你的问题范围比较窄，我按最直接的意思回答，没有往外扩展。`;

/** 选出装得下的最深一档，并把它编好号。 */
export function stepsFor(scene: Scene, cap: number, question: string): string {
  const anchor = anchorStep(question);
  for (const tier of stepTiers(scene, anchor)) {
    if (fits(tier, cap) && !tier.some((line) => containsBannedTerm(line)))
      return numberSteps(tier);
  }
  return numberSteps([SHORT_FALLBACK]);
}

export interface RuleAnalysis {
  summary: string;
  scene: Scene;
  warnings: string[];
}

export function analysisByRules(
  question: string,
  candidateReply: string,
  maxChars: number,
): RuleAnalysis {
  const warnings: string[] = [];
  const scene = detectScene(question, candidateReply);
  const cap = Math.min(
    analysisCapByLength(charLength(candidateReply.trim())),
    maxChars,
  );
  if (cap === 0) {
    // 正文只有语气词时反推不出有信息量的思路（Skill 明文规定），交回空摘要由 A 决定。
    return { summary: "", scene, warnings: ["DRAFT_TOO_SHORT"] };
  }
  let summary = stepsFor(scene, cap, question);
  if (containsBannedTerm(summary)) summary = numberSteps([SHORT_FALLBACK]);
  if (charLength(summary) > cap) {
    // 规则模式自己也不能违反封顶：超了就用更短的通用版，不做半句截断（截断会留下破句）。
    summary = numberSteps([SHORT_FALLBACK]);
    warnings.push("LENGTH_TRUNCATED");
  }
  if (charLength(summary) > cap) summary = "";
  return { summary, scene, warnings };
}

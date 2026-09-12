import { describe, expect, it } from "vitest";
import {
  analysisByRules,
  analysisCapByLength,
  anchorStep,
  rewriteByRules,
} from "../src/assist/rules.js";
import {
  charLength,
  containsBannedTerm,
  extractNumbers,
  findMarkdownStructure,
} from "../src/assist/validate.js";
import type { StyleLevel } from "../src/shared/types.js";

// 本地规则模式（PRD §9.1）：确定性与事实保持优先于文采。

const DRAFTS = [
  "这个接口明天能给你，但要先确认字段谁定。",
  "不行",
  "好",
  "第一，预算只剩 3 万；第二，交付压到 12 月 5 日；第三，测试要两个人。",
  "我不确定要不要现在做，你那边要是能等，我就先把手上的收掉。",
];

describe("rewriteByRules", () => {
  for (const level of ["轻微", "明显", "浓郁"] as StyleLevel[]) {
    it(`${level}：原文每句话都原样保留，不新增数字`, () => {
      for (const draft of DRAFTS) {
        const out = rewriteByRules(draft, level);
        for (const sentence of draft
          .split(/[。！？；]/)
          .map((s) => s.trim())
          .filter(Boolean)) {
          expect(out).toContain(sentence.slice(0, 4));
        }
        const added = extractNumbers(out).filter(
          (n) => !extractNumbers(draft).includes(n),
        );
        // 编号（1、2、3）是结构标记，允许；但不能新增带业务含义的数值。
        for (const n of added) expect(Number.isNaN(Number(n))).toBe(true);
      }
    });
  }

  it("三个档位产出确实不同（同输入不同档位必须能看出差别）", () => {
    const outputs = (["轻微", "明显", "浓郁"] as StyleLevel[]).map((l) =>
      rewriteByRules(DRAFTS[3], l),
    );
    expect(new Set(outputs).size).toBe(3);
  });

  it("输出永远是纯文本（无 Markdown / 无链接）", () => {
    for (const draft of DRAFTS) {
      for (const level of ["轻微", "明显", "浓郁"] as StyleLevel[]) {
        expect(findMarkdownStructure(rewriteByRules(draft, level))).toBeNull();
      }
    }
  });

  it("空草稿不加工", () => {
    expect(rewriteByRules("   ", "明显")).toBe("");
  });

  it("确定性：同一输入两次结果逐字相同", () => {
    expect(rewriteByRules(DRAFTS[0], "浓郁")).toBe(
      rewriteByRules(DRAFTS[0], "浓郁"),
    );
  });

  it("句末没标点时补句号（轻微档只做书写规范化）", () => {
    expect(rewriteByRules("这个我来看", "轻微")).toBe("这个我来看。");
    expect(rewriteByRules("这个我来看！", "轻微")).toBe("这个我来看！");
  });
});

describe("analysisByRules", () => {
  it("正文 ≤8 字不生成摘要，记 DRAFT_TOO_SHORT（Skill 封顶表）", () => {
    const result = analysisByRules("在吗", "在。", 300);
    expect(result.summary).toBe("");
    expect(result.warnings).toContain("DRAFT_TOO_SHORT");
  });

  // 2026-09-12 作者反馈「太短了，而且没有逻辑」：旧的 60/100/160/240 在六步链前面只装得下两句，
  // 两句之间看不出推导。现在这几档是按「装到第几步」定的，不是拍的整数。
  it("档位字数封顶（每档对应装到第几步）", () => {
    expect(analysisCapByLength(8)).toBe(0); // 语气词不生成
    expect(analysisCapByLength(9)).toBe(120); // 四步：锁定 + 定性 + 推导 + 收束
    expect(analysisCapByLength(31)).toBe(170); // 五到六步
    expect(analysisCapByLength(61)).toBe(240); // 整条链（六步 + 锁定最长 187）
    expect(analysisCapByLength(151)).toBe(300); // 与 maxAnalysisChars 默认值持平
  });

  it("摘要不超过封顶，也不超过宿主上限", () => {
    const long = "我先说结论。".repeat(30);
    for (const cap of [300, 100, 50]) {
      const result = analysisByRules("这个方案能上吗？", long, cap);
      expect(charLength(result.summary)).toBeLessThanOrEqual(cap);
    }
  });

  it("摘要里绝不出现内部机制词（会被 B 看穿）", () => {
    const cases: Array<[string, string]> = [
      ["这个能明天上线吗", "明天可以，但要先验一轮。"],
      ["为什么报错", "因为字段名对不上。"],
      ["那如果延期呢", "延期的话我这边先顶上。"],
      ["这个方案好还是那个好", "看你更在意成本还是速度。"],
      ["抱歉让你久等了", "久等了，现在给你结论。"],
      ["我不太舒服", "先歇一下，这事我顶着。"],
    ];
    for (const [question, reply] of cases) {
      const result = analysisByRules(question, reply, 300);
      expect(result.summary.length).toBeGreaterThan(0);
      expect(containsBannedTerm(result.summary)).toBeNull();
      expect(findMarkdownStructure(result.summary)).toBeNull();
    }
  });

  it("确定性 + 不含问题里的数字（不外推事实）", () => {
    const q = "预算 3 万够吗";
    const r = "够，但要砍掉两个非核心项。";
    const first = analysisByRules(q, r, 300);
    expect(first.summary).toBe(analysisByRules(q, r, 300).summary);
    // 第一步是「把对方的原话钉住」（anchorStep），那是原样引用，不是外推；
    // 把引号里那段摘掉之后再查：摘要自己不该带进任何问题里没有的数字。
    const own = first.summary.replace(/「[^」]*」/g, "");
    expect(extractNumbers(own)).toEqual([]);
    expect(first.summary).toContain("「预算3万够吗」");
  });

  it("场景判定覆盖到六种问题类型", () => {
    const scenes = new Set([
      analysisByRules("要不要现在做", "现在就做。", 300).scene,
      analysisByRules("为什么会这样", "因为配置没同步。", 300).scene,
      analysisByRules("那如果延一周呢", "那就先交付第一版。", 300).scene,
      analysisByRules("怎么还没好", "抱歉久等了，现在好。", 300).scene,
      analysisByRules("A 和 B 哪个好", "看你要哪个维度。", 300).scene,
      analysisByRules(
        "嗯",
        "嗯，我在。这里需要超过八个字才不会被封顶拦掉。",
        300,
      ).scene,
    ]);
    expect(scenes.size).toBeGreaterThanOrEqual(5);
  });
});

// 2026-09-12：B 侧反馈「看不到思考过程」的回归用例。
// 根因不在封顶表（表是对的：分析比正文长很多会立刻显得假），
// 而在模板装不下时直接掉到一句 28 字的兜底，于是「过程」被压成了一口气。
describe("analysisByRules 的分步输出", () => {
  const QUESTIONS: string[] = [
    "这个能周三前做完吗",
    "这个报错是什么意思",
    "那如果我先做设计稿呢",
    "抱歉让你久等了",
    "这两种方案哪个好一点",
    "帮我看看这个合同有没有问题",
  ];

  it("短正文也至少给出两步，而不是一句兜底", () => {
    const r = analysisByRules("这个能周三前做完吗", "可以，我周二给你初稿。", 300);
    expect(r.summary.split("\n").length).toBeGreaterThanOrEqual(2);
    expect(r.warnings).not.toContain("LENGTH_TRUNCATED");
  });

  it("一步一句：每步都不超过 Skill 的单句上限，且没有列表符号", () => {
    for (const q of QUESTIONS) {
      const summary = analysisByRules(q, "可以，我周二给你初稿，行不行你说。", 300)
        .summary;
      for (const line of summary.split("\n")) {
        expect(charLength(line)).toBeLessThanOrEqual(60);
        expect(line.trim()).toBe(line);
      }
      expect(findMarkdownStructure(summary)).toBeNull();
    }
  });

  it("封顶越大步数不减（四步 → 三步 → 两步 → 一句，绝不越界）", () => {
    const question = "这两种方案哪个好一点，理由是什么";
    const reply = "第一种更快但不好扩展，第二种慢一些但以后改起来省事。";
    let prevSteps = 0;
    for (const cap of [60, 100, 160, 240]) {
      const summary = analysisByRules(question, reply, cap).summary;
      const steps = summary.split("\n").length;
      expect(charLength(summary)).toBeLessThanOrEqual(cap);
      expect(steps).toBeGreaterThanOrEqual(prevSteps);
      prevSteps = steps;
    }
    expect(prevSteps).toBeGreaterThanOrEqual(3);
  });

  it("六种场景在任何封顶下都不发空摘要（≤8 字正文那条除外）", () => {
    for (const q of QUESTIONS)
      for (const cap of [60, 100, 240])
        expect(
          analysisByRules(q, "可以，我周二给你初稿，行不行你说。", cap).summary
            .length,
        ).toBeGreaterThan(0);
  });
});

// ── 2026-09-12 第二轮：作者说「太短了，而且没有逻辑」───────────────────────────
// 改法不是把字数硬撑，而是把四句并列换成六步推导（定性→排除→依据→推导→边界→收束），
// 再加一步「把对方的原话钉住」：整条链第一句就在说这一件事，而不是套模板。
describe("反推的推导链", () => {
  const numbered = (summary: string) => summary.split("\n");

  it("编号永远连着，不跳号（跳号一眼假）", () => {
    for (const cap of [60, 120, 170, 300]) {
      const lines = numbered(
        analysisByRules("这两种方案哪个好一点？", "第一个更快，第二个好扩展。", cap)
          .summary,
      );
      lines.forEach((line, i) => expect(line.startsWith(`${i + 1}、`)).toBe(true));
    }
  });

  it("装得下时以「检查一遍」收尾（校验步在，链路才闭合）", () => {
    // 正文写到 31 字以上才给到 170 那一档，链子才铺得开
    const summary = analysisByRules(
      "这个周五之前能给我吗？",
      "可以，周五前给你初稿。我周二先把框架搭起来，剩下三天补完，需要人手的部分我提前跟你说。",
      300,
    ).summary;
    const lines = numbered(summary);
    expect(lines.length).toBeGreaterThanOrEqual(5);
    expect(lines[lines.length - 1]).toContain("检查一遍");
  });

  it("第一步引用对方原话（钉住这件事），且只是原样引用", () => {
    const summary = analysisByRules(
      "这个周五之前能把初稿给我吗？",
      "可以，周五前给你。",
      300,
    ).summary;
    expect(numbered(summary)[0]).toContain("这个周五之前能把初稿给我吗？");
  });

  it("原话里带内部用词就不引用（不把提示注入贴进自己的思考过程）", () => {
    for (const q of [
      "这个模型的档位怎么调？", // 含禁用词
      "嗯？", // 太短
      "这是一条长得离谱的提问，长到引用出来会占掉小半条摘要，那就不如不引用。", // 太长
    ]) {
      const anchor = anchorStep(q);
      expect(anchor).toBe("");
    }
  });

  it("每步单句不超 Skill 的 60 字上限，且没有 markdown 符号", () => {
    for (const q of [
      "这个能周三前做完吗",
      "这个报错是什么意思",
      "那如果我先做设计稿呢",
      "抱歉让你久等了",
      "这两种方案哪个好一点",
    ]) {
      const summary = analysisByRules(
        q,
        "可以，我周二给你初稿，行不行你说一句。",
        300,
      ).summary;
      for (const line of numbered(summary)) {
        expect(charLength(line)).toBeLessThanOrEqual(60);
        expect(line.trim()).toBe(line);
      }
      expect(findMarkdownStructure(summary)).toBeNull();
      expect(containsBannedTerm(summary)).toBeNull();
    }
  });
});

// ── 处置正文：引导语只加一次，三档要看得出差别 ──────────────────────────────
describe("处置正文的引导语（作者：不要每句都带「我这边的情况是：」）", () => {
  const THREE = "先确认字段。再排一次期。最后我来跟。";

  it("多句正文只在开头加一条引导语，其余用编号行", () => {
    const out = rewriteByRules(THREE, "明显");
    const lines = out.split("\n");
    // 第一行是引导语 + 首句；后面每行都是「N、」开头
    expect(out.match(/：/g)!.length).toBeLessThanOrEqual(2);
    for (const line of lines.slice(1)) expect(/^[1-9]、/.test(line)).toBe(true);
    // 引导语全篇只出现一次，不逐句重复
    const lead = out.slice(0, out.indexOf("：") + 1);
    expect(out.split(lead).length - 1).toBe(1);
  });

  it("同一段正文点两次不会套娃（前缀不叠加）", () => {
    const once = rewriteByRules(THREE, "明显");
    expect(rewriteByRules(once, "明显")).toBe(once);
    const heavyOnce = rewriteByRules(THREE, "浓郁");
    expect(rewriteByRules(heavyOnce, "浓郁")).toBe(heavyOnce);
  });

  it("不同草稿的引导语会换着来（池子里五条，不是永远同一句）", () => {
    const leads = new Set(
      [
        "可以，周五前给你。",
        "我这边没问题，你直接推进就行。",
        "这个要问一下财务那边。",
        "先把测试补上，别的回头说。",
        "今天来不及，明天上午给你。",
      ].map((d) => rewriteByRules(d, "明显").slice(0, 6)),
    );
    expect(leads.size).toBeGreaterThanOrEqual(2);
  });

  it("单句正文下三档互不相同（旧版 浓郁 会退化成 明显）", () => {
    const one = "可以，周五前给你。";
    const light = rewriteByRules(one, "轻微");
    const mid = rewriteByRules(one, "明显");
    const heavy = rewriteByRules(one, "浓郁");
    expect(new Set([light, mid, heavy]).size).toBe(3);
    expect(heavy).toContain("1、");
  });

  it("改的是排版，没有加词：编号里的字全部来自原句", () => {
    const out = rewriteByRules(THREE, "浓郁");
    const kept = out.replace(/[1-9]、|我把这句拆开说：|\n/g, "").replace(/。/g, "");
    const src = THREE.replace(/。/g, "");
    expect(kept).toBe(src);
  });
});

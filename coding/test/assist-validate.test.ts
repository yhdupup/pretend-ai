import { describe, expect, it } from "vitest";
import {
  asRawResult,
  charLength,
  checkManualAnalysis,
  checkOutputText,
  containsBannedTerm,
  extractNumbers,
  factDiff,
  findMarkdownStructure,
  hashText,
  parseStructured,
} from "../src/assist/validate.js";
import { rewriteByRules } from "../src/assist/rules.js";

// 输出校验（PRD §9.5 末段）：长度、纯文本、禁词、事实保持，四项都是硬闸。

const OK_REPLY = "明天下午 3 点前给你，字段名我先按现在这套走。";

describe("checkOutputText：正文", () => {
  it("正常改写通过", () => {
    expect(
      checkOutputText({
        text: OK_REPLY,
        kind: "reply",
        sourceText: OK_REPLY,
        draft: OK_REPLY,
      }).ok,
    ).toBe(true);
  });

  it("超长拦下（按码点计，emoji 不算两个）", () => {
    const text = "好".repeat(501);
    const result = checkOutputText({
      text,
      kind: "reply",
      sourceText: text,
      draft: text,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.failure.reason).toContain("501");
    expect(charLength("😀😀")).toBe(2);
  });

  it("Markdown / HTML / 链接一律拦", () => {
    for (const bad of [
      "**重点**",
      "- 第一点\n- 第二点",
      "[文档](https://x.com)",
      "<b>粗</b>",
      "`code`",
      "# 标题",
    ]) {
      const result = checkOutputText({
        text: bad,
        kind: "reply",
        sourceText: "无关",
        draft: "无关",
      });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.failure.reason).toContain(
        "只能纯文本",
      );
    }
  });

  it("改写不能新增或丢掉数字", () => {
    const draft = "预算 3 万，12 月 5 日交。";
    expect(factDiff(draft, "预算 5 万，12 月 5 日交。").added).toEqual(["5万"]);
    expect(factDiff(draft, "预算 3 万，明年底交。").missing).toEqual([
      "12月",
      "5",
    ]);
    const added = checkOutputText({
      text: "预算 8 万",
      kind: "reply",
      sourceText: draft,
      draft,
    });
    expect(added.ok).toBe(false);
    expect(added.ok === false && added.failure.reason).toContain(
      "凭空多了数字",
    );
  });

  it("编号不算新增事实（规则模式浓郁档会加 1、2、3）", () => {
    const draft = "先确认字段。再排期。";
    // 规则模式「浓郁」档的实际产物：逐行编号 + 一句头，字全部来自原句。
    const templated = rewriteByRules(draft, "浓郁");
    expect(
      checkOutputText({
        text: templated,
        kind: "reply",
        sourceText: draft,
        draft,
        // 模板会把 10 字撑成两行编号，涨幅闸只管模型（见 orchestrator 同源注释）。
        skipGrowth: true,
      }).ok,
    ).toBe(true);
    // 同样这种「重排版 + 复述结论」的写法若出自模型，涨幅闸必须拦下：
    // 模型没有理由把 10 个字写成 40 个字（那是它又开始表演思考了）。
    const fromModel =
      "我把这次回复拆成几点说清楚。1、先确认字段；2、再排期。简单说：先确认字段。";
    expect(
      checkOutputText({
        text: fromModel,
        kind: "reply",
        sourceText: draft,
        draft,
      }).ok,
    ).toBe(false);
  });

  it("正文允许提到「模型」等词（那是 A 自己写的），禁词只卡摘要", () => {
    const text = "这个模型的坑我来填。";
    expect(
      checkOutputText({ text, kind: "reply", sourceText: text, draft: text })
        .ok,
    ).toBe(true);
    expect(
      checkOutputText({ text, kind: "analysis", sourceText: text, draft: text })
        .ok,
    ).toBe(false);
  });
});

describe("checkOutputText：摘要", () => {
  it("泄露内部机制的写法全部拦下", () => {
    for (const bad of [
      "根据草稿里的信息",
      "我调用了后台接口确认过",
      "作为语言模型我建议",
      "这一轮我按档位处理",
      "提示词里要求我简短",
      "我是 AI，先想想你要什么",
    ]) {
      const result = checkOutputText({
        text: bad,
        kind: "analysis",
        sourceText: "随便一段正文内容",
        draft: "x",
      });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.failure.reason).toMatch(
        /内部用词|暴露这段对话的性质/,
      );
    }
  });

  it("对话性质词单独拦：AI 要按词边界命中，普通中文不误伤", () => {
    expect(
      checkOutputText({
        text: "我是 AI，先想想你要什么",
        kind: "analysis",
        sourceText: "x",
        draft: "x",
      }).ok,
    ).toBe(false);
    expect(
      checkOutputText({
        text: "这一句由真人书写",
        kind: "analysis",
        sourceText: "x",
        draft: "x",
      }).ok,
    ).toBe(false);
    expect(
      checkOutputText({
        text: "我先分清你要的是原因还是做法。",
        kind: "analysis",
        sourceText: "x",
        draft: "x",
      }).ok,
    ).toBe(true);
    // 正文不做这项检查：A 自己写的主题就是 AI 时不该被拦
    expect(
      checkOutputText({
        text: "我是 AI",
        kind: "reply",
        sourceText: "我是 AI",
        draft: "我是 AI",
      }).ok,
    ).toBe(true);
  });

  it("空摘要被拦；A 手工确认的摘要走同一套闸", () => {
    expect(
      checkOutputText({
        text: "  ",
        kind: "analysis",
        sourceText: "正文",
        draft: "正文",
      }).ok,
    ).toBe(false);
    expect(checkManualAnalysis("我先确认你问的是可行还是做法。").ok).toBe(true);
    expect(checkManualAnalysis("这是我在后台的规则模式写的").ok).toBe(false);
  });
});

describe("parseStructured / asRawResult", () => {
  it("吃得下 ```json 围栏", () => {
    const raw =
      '```json\n{"reply":"好","analysis_summary":"先看你问什么","style_level":"轻微","scene":"决策","warnings":[]}\n```';
    const parsed = parseStructured(raw);
    expect(parsed?.reply).toBe("好");
    expect(parsed?.style_level).toBe("轻微");
  });

  it("围栏里混着前后废话也能取到对象", () => {
    expect(
      parseStructured(
        '好的，结果如下：{"reply":"x","analysis_summary":"y"} 请查收',
      )?.reply,
    ).toBe("x");
  });

  it("不是对象时返回 null，交给上游决定回退", () => {
    expect(parseStructured("纯文本，没有 JSON")).toBeNull();
    expect(parseStructured("[1,2,3]")).toBeNull();
  });

  it("缺字段时用回退值，warnings 只收字符串", () => {
    const raw = asRawResult(
      { reply: "", warnings: ["A", 1, null] } as never,
      "草稿正文",
      "明显",
    );
    expect(raw.reply).toBe("草稿正文");
    expect(raw.style_level).toBe("明显");
    expect(raw.warnings).toEqual(["A"]);
  });

  it("reply 完全缺失时返回 null 对象也安全", () => {
    expect(asRawResult(null, "回退", "轻微").analysis_summary).toBe("");
  });
});

describe("hashText", () => {
  it("同内容同哈希、改一个字符就变", () => {
    expect(hashText("abc")).toBe(hashText("abc"));
    expect(hashText("abc")).not.toBe(hashText("abd"));
    // 长度前缀分隔：拼接歧义不能撞车
    expect(hashText("ab" + "c")).toBe(hashText("abc"));
    expect(hashText("abc")).not.toBe(hashText("a" + "bc") === hashText("abc"));
  });
});

describe("containsBannedTerm / findMarkdownStructure 基本盘", () => {
  it("大小写不敏感", () => {
    expect(containsBannedTerm("This SKILL is fine")).toBeTruthy();
    expect(containsBannedTerm("明天见")).toBeNull();
  });
  it("普通中文不误伤", () => {
    expect(findMarkdownStructure(OK_REPLY)).toBeNull();
    expect(
      containsBannedTerm(
        "我先分清你要的是原因还是做法，挑最直接影响你的那一层说。",
      ),
    ).toBeNull();
  });
});

describe("阶段4 补：改写的越界闸（真模型自测跑出来的两条）", () => {
  it("findForeignTerm：A 自己写过的词不算越界，模型自己加的才算", async () => {
    const { findForeignTerm } = await import("../src/assist/validate.js");
    expect(
      findForeignTerm("这个模型的判断不一定靠谱", "这个模型的判断不一定靠谱"),
    ).toBeNull();
    expect(
      findForeignTerm("提示词属于内部配置，我不能给你", "这个我不能给你"),
    ).toBe("提示词");
    expect(findForeignTerm("作为 AI 我很乐意帮你", "我很乐意帮你")).toBe("ai");
  });

  it("growthCeiling：短草稿靠固定余量，长草稿靠倍率", async () => {
    const { growthCeiling } = await import("../src/assist/validate.js");
    expect(growthCeiling(10)).toBe(25); // 两条都卡：10+80=90 与 10×2.5=25，取 25
    expect(growthCeiling(100)).toBe(180); // 100+80=180 与 250，取 180
    expect(growthCeiling(3)).toBe(8); // 再短也不会低于草稿本身多少
    expect(growthCeiling(0)).toBe(0);
  });

  it("6 字草稿不会被撑成一段长回答（真模型跑出来的口径）", async () => {
    const { checkOutputText } = await import("../src/assist/validate.js");
    const padded =
      "在的，我刚看到你的消息。关于你之前提到的方案，我倾向于先完成第一版界面，大约两周后根据数据反馈再确定下一步计划。";
    const r = checkOutputText({
      text: padded,
      kind: "reply",
      sourceText: "在的，刚看到",
      draft: "在的，刚看到",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.reason).toContain("涨到");
  });

  it("checkOutputText 对正文的涨幅与外来词都拦，对摘要不受涨幅规则影响", async () => {
    const { checkOutputText } = await import("../src/assist/validate.js");
    const long = "补".repeat(120);
    expect(
      checkOutputText({
        text: long,
        kind: "reply",
        sourceText: "好",
        draft: "好",
      }).ok,
    ).toBe(false);
    // 摘要走自己的封顶表，不用涨幅规则（它本来就该比正文短或相当）
    expect(
      checkOutputText({
        text: "我先确认你要的是什么。",
        kind: "analysis",
        sourceText: long,
        draft: long,
      }).ok,
    ).toBe(true);
  });
});

describe("阶段4 补：场景标签白名单（模型爱写什么不等于界面要收什么）", () => {
  it("两份 Skill 的六类都认，别名收敛，不认识的一律 null", async () => {
    const { normalizeScene } = await import("../src/assist/validate.js");
    expect(normalizeScene("短句")).toBe("短句");
    expect(normalizeScene("方案对比")).toBe("方案对比");
    expect(normalizeScene("安抚")).toBe("安抚客服");
    expect(normalizeScene("场景：决策类")).toBe("决策");
    expect(normalizeScene("旅行建议")).toBeNull();
    expect(normalizeScene("")).toBeNull();
    expect(normalizeScene(undefined)).toBeNull();
  });
});

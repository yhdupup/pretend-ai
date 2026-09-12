import { describe, expect, it } from "vitest";
import {
  analysisBound,
  analysisStale,
  assistRunPayload,
  shouldShowAnalysisBox,
} from "../apps/a-frontend/src/assist-run";

// 会话页「处置正文 / 深度反推」两个按钮的绑定关系。
// 之所以单测：2026-09-12 用户报「B 那边看不到深度思考的过程」，根因不在 B 端、
// 也不在服务端，而在拆开两个按钮之后：后一次 /process 会把前一次生成的过程顶成空，
// 而输入框里的字还留着 —— 看着有、发出去没有。这类"界面与载荷不一致"只能靠断言钉住。

const P = (analysisSummary: string, reply = "正文") => ({
  analysisSummary,
  reply,
});

describe("assistRunPayload：两个按钮各写各的字段", () => {
  it("处置正文只开正文那一栏，不顺手生成过程", () => {
    expect(assistRunPayload("polish", "在的不", "明显")).toEqual({
      draft: "在的不",
      aiStyleEnabled: true,
      analysisEnabled: false,
      styleLevel: "明显",
    });
  });

  it("深度反推只开过程那一栏，正文原样送回去（服务端不会重写它）", () => {
    expect(assistRunPayload("analysis", "在的不", "浓郁")).toEqual({
      draft: "在的不",
      aiStyleEnabled: false,
      analysisEnabled: true,
      styleLevel: "浓郁",
    });
  });
});

describe("§6.6 闸门：框里那段过程到底算不算绑定", () => {
  it("没写过程 = 纯发正文，不算不一致", () => {
    expect(analysisBound("", null)).toBe(true);
    expect(analysisBound("   ", P(""))).toBe(true);
    expect(analysisStale({ analysis: "", process: null })).toBe(false);
  });

  it("刚点完深度反推、文本没动 → 绑定好了，可以直接发", () => {
    expect(analysisBound("我先看你问的是哪一层", P("我先看你问的是哪一层"))).toBe(
      true,
    );
  });

  it("A 手改了过程文本但没点确认 → 拦下（服务端取的是生成记录，不是框里的字）", () => {
    expect(
      analysisStale({
        analysis: "我先看你问的是哪一层，再决定说多少",
        process: P("我先看你问的是哪一层"),
      }),
    ).toBe(true);
  });

  it("核心那条：点完深度反推再点处置正文，过程被顶掉 → 必须拦，不能偷偷发出去", () => {
    expect(
      analysisStale({ analysis: "我先看你问的是哪一层", process: P("") }),
    ).toBe(true);
  });

  it("一次按钮都没点、A 全手写 → 也算未绑定，先拦一下（「确认这条摘要」会顺手建记录）", () => {
    expect(analysisStale({ analysis: "我自己写的过程", process: null })).toBe(
      true,
    );
    expect(analysisBound("我自己写的过程", null)).toBe(false);
  });
});

describe("「展示给对方的分析过程」框的露出条件", () => {
  it("没有待回答的问题时不出现（没锚点，这段发不出去）", () => {
    expect(
      shouldShowAnalysisBox({
        analysisEnabled: true,
        analysis: "",
        hasPending: false,
      }),
    ).toBe(false);
  });

  it("全局开关开着 + 有提问 → 出现", () => {
    expect(
      shouldShowAnalysisBox({ analysisEnabled: true, analysis: "", hasPending: true }),
    ).toBe(true);
  });

  it("开关关着但框里已经躺着一段会被发出去的过程 → 仍然得露出来", () => {
    expect(
      shouldShowAnalysisBox({
        analysisEnabled: false,
        analysis: "上一轮生成的过程",
        hasPending: true,
      }),
    ).toBe(true);
  });
});

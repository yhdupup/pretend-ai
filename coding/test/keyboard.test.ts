import { describe, expect, it } from "vitest";
import {
  enterKeyAction,
  keySignalFrom,
  type EnterKeySignal,
} from "../src/shared/keyboard";

// PRD §5.5 + §6.7 那三条键盘规则。真输入法只有人眼验得准，
// 但「判定」本身是纯函数，这里逐条钉住，前端改一行就会红。
const sig = (over: Partial<EnterKeySignal> = {}): EnterKeySignal => ({
  key: "Enter",
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  isComposing: false,
  ...over,
});

describe("Enter 发送判定（PRD §5.5 / §6.7）", () => {
  it("裸 Enter 发送", () => {
    expect(enterKeyAction(sig())).toBe("send");
  });

  it("Shift+Enter 换行，不发送", () => {
    expect(enterKeyAction(sig({ shiftKey: true }))).toBe("newline");
  });

  it("输入法组词态下 Enter 不发送（PRD §5.5 硬要求）", () => {
    expect(enterKeyAction(sig({ isComposing: true }))).toBe("ignore");
    expect(
      enterKeyAction(sig({ isComposing: true, shiftKey: true })),
    ).toBe("ignore");
  });

  it("Cmd/Ctrl+Enter 任何输入法下都发送", () => {
    expect(enterKeyAction(sig({ metaKey: true }))).toBe("send");
    expect(enterKeyAction(sig({ ctrlKey: true }))).toBe("send");
    expect(
      enterKeyAction(sig({ ctrlKey: true, isComposing: true })),
    ).toBe("send");
    expect(
      enterKeyAction(sig({ metaKey: true, shiftKey: true })),
    ).toBe("send");
  });

  it("其它键一律不插手，交给浏览器原生行为", () => {
    for (const key of ["a", " ", "Tab", "Escape", "Backspace", "Process"]) {
      expect(enterKeyAction(sig({ key }))).toBe("ignore");
    }
  });
});

describe("keySignalFrom：从事件对象抠字段", () => {
  it("读 nativeEvent.isComposing", () => {
    const e = {
      key: "Enter",
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
      nativeEvent: { isComposing: true },
    };
    expect(keySignalFrom(e).isComposing).toBe(true);
    expect(enterKeyAction(keySignalFrom(e))).toBe("ignore");
  });

  it("旧浏览器没有 isComposing，只有 keyCode 229 —— 也要认（Safari/老 Chrome）", () => {
    const e = {
      key: "Enter",
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
      keyCode: 229,
    };
    expect(keySignalFrom(e).isComposing).toBe(true);
    expect(enterKeyAction(keySignalFrom(e))).toBe("ignore");
  });

  it("没有 nativeEvent 也不炸", () => {
    const e = {
      key: "Enter",
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
    };
    expect(keySignalFrom(e).isComposing).toBe(false);
    expect(enterKeyAction(keySignalFrom(e))).toBe("send");
  });
});

// PRD §5.5 / §6.7：桌面端 Enter 发送、Shift+Enter 换行、中文输入法组词态 Enter 不发送。
// 单独放一个纯函数，是因为「组词中按回车」这件事只有真浏览器 + 真输入法才演得出来，
// 把判断本身抽出来才能在 node 里逐条断言（组件里只负责把事件字段递进来）。

export type EnterAction = "send" | "newline" | "ignore";

export interface EnterKeySignal {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  /** 输入法正在组词（Safari/Chrome 都给 nativeEvent.isComposing；老 Chrome 只给 keyCode 229）。 */
  isComposing: boolean;
}

/**
 * 判定一次按键对「发送」意味着什么。
 * 只认 Enter，其它键一律 ignore（交给浏览器原生行为）。
 */
export function enterKeyAction(e: EnterKeySignal): EnterAction {
  if (e.key !== "Enter") return "ignore";
  // Cmd/Ctrl + Enter：显式意图，任何输入法下都发送（阶段四冒烟 §五.9）。
  if (e.metaKey || e.ctrlKey) return "send";
  // 组词状态下回车是「上屏」，不是「发送」——抢了就把中文打字变成灾难（§5.5）。
  if (e.isComposing) return "ignore";
  // Shift + Enter：换行（§6.7）。
  if (e.shiftKey) return "newline";
  return "send";
}

/** 从按键事件上把判断需要的字段抠出来。结构化的最小类型，免得 shared 层依赖 React 类型。 */
export interface KeyLike {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  nativeEvent?: { isComposing?: boolean };
  keyCode?: number;
}

export function keySignalFrom(e: KeyLike): EnterKeySignal {
  return {
    key: e.key,
    shiftKey: e.shiftKey,
    metaKey: e.metaKey,
    ctrlKey: e.ctrlKey,
    // keyCode 229 = 未识别键，是旧版 Chrome/Safari 表达「正在组词」的唯一方式
    isComposing: !!e.nativeEvent?.isComposing || e.keyCode === 229,
  };
}

import { randomUUID } from "node:crypto";
import type {
  AssistMode,
  ChatMessage,
  MessageAssistMeta,
  MessageSender,
  PendingMessageInfo,
  PendingMessageState,
  SkillRef,
  StyleLevel,
} from "../../shared/types.js";
import { assertValidPendingTransition } from "./state-machine.js";

// 阶段1：聊天正文与 pending 队列仅存内存，进程重启即丢失（预期设计，见开发文档 §六）。

interface PendingEntry extends PendingMessageInfo {
  sessionId: string;
}

/**
 * 一次「处理草稿」的结果（PRD §6.6 一致性校验用）。
 * 只存哈希与摘要文本，不存草稿正文：草稿已经在 A 编辑器里，服务端多一份就多一份泄露面。
 */
export interface ProcessRecord {
  id: string;
  sessionId: string;
  replyHash: string;
  analysisHash: string;
  analysisSummary: string;
  styleLevel: StyleLevel;
  mode: AssistMode;
  scene: string | null;
  skillRefs: SkillRef[];
  createdAtMs: number;
}

/** 会话清理事务必须一并删掉这些东西（PRD §16.6）：生成结果 + 限速计数 + pending 的 GENERATING 状态。 */
const PROCESS_TTL_MS = 10 * 60_000;

export class PendingNotFoundError extends Error {
  constructor(sessionId: string, pendingId: string) {
    super(`Pending message not found: ${sessionId}/${pendingId}`);
    this.name = "PendingNotFoundError";
  }
}

export class MemoryStore {
  private readonly messages = new Map<string, ChatMessage[]>();
  private readonly pending = new Map<string, PendingEntry[]>();
  private readonly processes = new Map<string, Map<string, ProcessRecord>>();
  private readonly processAttempts = new Map<string, number[]>();
  private readonly inFlight = new Set<string>();

  appendMessage(
    sessionId: string,
    sender: MessageSender,
    body: string,
    assist?: { analysisSummary?: string | null; meta?: MessageAssistMeta },
  ): ChatMessage {
    const message: ChatMessage = {
      id: randomUUID(),
      sessionId,
      sender,
      body,
      createdAt: new Date().toISOString(),
      ...(assist?.analysisSummary
        ? { analysisSummary: assist.analysisSummary }
        : {}),
      ...(assist?.meta ? { assist: assist.meta } : {}),
    };
    const list = this.messages.get(sessionId) ?? [];
    list.push(message);
    this.messages.set(sessionId, list);
    return message;
  }

  getMessages(sessionId: string): ChatMessage[] {
    return [...(this.messages.get(sessionId) ?? [])];
  }

  getMessagesAfter(
    sessionId: string,
    afterMessageId: string | undefined,
  ): ChatMessage[] {
    const list = this.messages.get(sessionId) ?? [];
    if (!afterMessageId) return [...list];
    const index = list.findIndex((m) => m.id === afterMessageId);
    if (index === -1) return [...list];
    return list.slice(index + 1);
  }

  createPending(sessionId: string, body: string): PendingMessageInfo {
    const entry: PendingEntry = {
      id: randomUUID(),
      sessionId,
      state: "WAITING_A",
      body,
      createdAt: new Date().toISOString(),
    };
    // IDLE -> WAITING_A：新 pending 项创建时即代表"等待 A 处理"。
    assertValidPendingTransition("IDLE", "WAITING_A");
    const list = this.pending.get(sessionId) ?? [];
    list.push(entry);
    this.pending.set(sessionId, list);
    return {
      id: entry.id,
      state: entry.state,
      body: entry.body,
      createdAt: entry.createdAt,
    };
  }

  listPending(sessionId: string): PendingMessageInfo[] {
    return (this.pending.get(sessionId) ?? []).map(
      ({ id, state, body, createdAt }) => ({
        id,
        state,
        body,
        createdAt,
      }),
    );
  }

  /** 返回最早一条仍处于 WAITING_A 的 pending 项，供 A 回复时消费。 */
  oldestWaiting(sessionId: string): PendingMessageInfo | undefined {
    const list = this.pending.get(sessionId) ?? [];
    const found = list.find(
      (p) =>
        p.state === "WAITING_A" ||
        p.state === "GENERATING" ||
        p.state === "READY",
    );
    if (!found) return undefined;
    return {
      id: found.id,
      state: found.state,
      body: found.body,
      createdAt: found.createdAt,
    };
  }

  transitionPending(
    sessionId: string,
    pendingId: string,
    to: PendingMessageState,
  ): PendingMessageInfo {
    const list = this.pending.get(sessionId) ?? [];
    const entry = list.find((p) => p.id === pendingId);
    if (!entry) throw new PendingNotFoundError(sessionId, pendingId);
    assertValidPendingTransition(entry.state, to);
    entry.state = to;
    return {
      id: entry.id,
      state: entry.state,
      body: entry.body,
      createdAt: entry.createdAt,
    };
  }

  /**
   * 传给外部模型的历史（PRD §8.2：最多最近 10 个已完成轮次，更早内容不传）。
   * 一轮 = B 一问 + A 一答，所以条数 = min(上限轮数, 已完成轮数) × 2。
   * 当前那条还没回答的问题不在里面（它单独走 pendingQuestion）。
   */
  recentMessagesForModel(
    sessionId: string,
    maxRounds: number,
    completedRounds: number,
  ): Array<{ role: "a" | "b"; body: string }> {
    const take = Math.max(0, Math.min(maxRounds, completedRounds)) * 2;
    if (!take) return [];
    return this.getMessages(sessionId)
      .slice(-take)
      .map((m) => ({
        role: m.sender === "A" ? ("a" as const) : ("b" as const),
        body: m.body,
      }));
  }

  rememberProcess(record: ProcessRecord): void {
    const list =
      this.processes.get(record.sessionId) ?? new Map<string, ProcessRecord>();
    list.set(record.id, record);
    this.processes.set(record.sessionId, list);
  }

  /** 取生成结果；过期（>10 分钟）或不属于本会话的都当作不存在。 */
  findProcess(
    sessionId: string,
    processId: string,
    nowMs = Date.now(),
  ): ProcessRecord | undefined {
    const found = this.processes.get(sessionId)?.get(processId);
    if (!found) return undefined;
    if (nowMs - found.createdAtMs > PROCESS_TTL_MS) {
      this.processes.get(sessionId)?.delete(processId);
      return undefined;
    }
    return found;
  }

  updateProcessAnalysis(
    sessionId: string,
    processId: string,
    analysisSummary: string,
    analysisHash: string,
  ): boolean {
    const found = this.processes.get(sessionId)?.get(processId);
    if (!found) return false;
    found.analysisSummary = analysisSummary;
    found.analysisHash = analysisHash;
    return true;
  }

  /**
   * A 改过正文并显式确认后，把正文哈希前移（PRD §6.6 的「重新确认」）。
   * 只动哈希，不动摘要：确认动作不代表重新生成。
   */
  updateProcessReply(
    sessionId: string,
    processId: string,
    replyHash: string,
  ): boolean {
    const found = this.processes.get(sessionId)?.get(processId);
    if (!found) return false;
    found.replyHash = replyHash;
    return true;
  }

  /**
   * 同一会话同时只允许一个生成任务在跑（PRD §9.3 条件 5）。
   * 用独立的 in-flight 集合，不复用 pending 的 GENERATING 状态：GENERATING 一旦置上就留在队列里
   * 直到 A 发送（B 侧靠它继续显示「对方正在输入」），它表示「A 正在处理」而不是「请求还在飞」。
   */
  beginProcess(sessionId: string): boolean {
    if (this.inFlight.has(sessionId)) return false;
    this.inFlight.add(sessionId);
    return true;
  }

  endProcess(sessionId: string): void {
    this.inFlight.delete(sessionId);
  }

  isGenerating(sessionId: string): boolean {
    return this.inFlight.has(sessionId);
  }

  /**
   * 限速（PRD §24.4）：同一会话两次生成的最小间隔 + 每分钟次数。
   * 放在内存 store 里，是为了让会话清理事务能顺手把它一起删掉（不然计数会跨会话累积）。
   */
  /** 处理草稿限速。两个阈值传 0 或负数 = 该项不限。 */
  allowProcess(
    sessionId: string,
    nowMs: number,
    minIntervalMs: number,
    perMinute: number,
  ): boolean {
    const stamps = (this.processAttempts.get(sessionId) ?? []).filter(
      (t) => nowMs - t < 60_000,
    );
    const last = stamps[stamps.length - 1];
    // 0（含负数）= 这一项不限。写成 `stamps.length >= 0` 会把所有限速都变成全拦，
    // 自测脚本传 0 想关掉限速时就会一头雾水（阶段4 冒烟就是这么撞上的）。
    if (minIntervalMs > 0 && last !== undefined && nowMs - last < minIntervalMs)
      return false;
    if (perMinute > 0 && stamps.length >= perMinute) return false;
    stamps.push(nowMs);
    this.processAttempts.set(sessionId, stamps);
    return true;
  }

  /** 测试/清理专用：清空指定会话的内存数据。 */
  clearSession(sessionId: string): void {
    this.messages.delete(sessionId);
    this.pending.delete(sessionId);
    this.processes.delete(sessionId);
    this.processAttempts.delete(sessionId);
    this.inFlight.delete(sessionId);
  }
}

export const memoryStore = new MemoryStore();

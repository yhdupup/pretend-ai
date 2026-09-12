// A/B 共用的类型定义。不含任何敏感逻辑，可安全被前端引用。

export type SessionState =
  "STARTING" | "WAITING" | "ACTIVE" | "CLOSING_GRACE" | "CLOSED" | "EXPIRED";

export type RevealState = "HIDDEN" | "REVEALED";

export type RevealReason = "ROUND_LIMIT" | "TIME_LIMIT" | "OWNER_ACTION";

// 阶段3：公网链接作废的原因。会话行上留着它，B 再打过来时给 410 而不是 404（PRD §4）。
export type LinkInvalidatedReason =
  "TUNNEL_DOWN" | "TUNNEL_STOPPED" | "TUNNEL_URL_CHANGED";

export type PendingMessageState =
  | "IDLE"
  | "WAITING_A"
  | "GENERATING"
  | "READY"
  | "SENDING"
  | "DELIVERED"
  | "DROPPED";

export type MessageSender = "A" | "B";

export interface ChatMessage {
  id: string;
  sessionId: string;
  sender: MessageSender;
  body: string;
  createdAt: string;
  // 阶段4（PRD §6.5/§7.4）：随这条回复一起展示给 B 的可分析过程；开关关/未生成时 null。
  analysisSummary?: string | null;
  // 阶段4：生成来源与 Skill 版本（PRD §9.2「发布包记录名称、哈希、版本」的运行时形式）。
  // **只给 A 看，不能出现在 B 侧响应里**（§8.3），所以 public 路由要用 toPublicMessage 剔掉它。
  assist?: MessageAssistMeta;
}

// 一条消息是怎么来的：mode=人工原文 / rules=本地规则 / user_model=自备模型。
export interface MessageAssistMeta {
  mode: AssistMode;
  styleLevel?: StyleLevel;
  scene?: string;
  skillRefs?: SkillRef[];
  processId?: string;
}

export interface SessionSummary {
  id: string;
  state: SessionState;
  revealState: RevealState;
  revealReason: RevealReason | null;
  revealedAt: string | null;
  createdAt: string;
  updatedAt: string;
  // 阶段2 缺口3/4：揭晓与过期时间由服务端算定（PRD §16.6 不接受前端提交时间）
  revealDeadlineAt: string;
  expiresAt: string;
  // 「创建满 N 分钟自动揭晓」的 N（TIME_LIMIT_MINUTES）。A 页面上「距创建已满 N 分钟」
  // 这类文案必须跟着它走，否则改了环境变量界面还把旧时长写在标签里。
  timeLimitMinutes: number;
  lastOwnerHeartbeatAt: string | null;
  // 阶段2 缺口5：本会话快照的身份与文案
  profile: SessionProfile;
  // 阶段3：B 链接。基址由隧道状态决定，所以会话行里只存路径。
  publicPath: string;
  // 阶段3：链接是否已经因为公网中断/换地址/通道停止而作废（PRD §4「旧链接失效」）
  linkInvalidatedAt: string | null;
  linkInvalidatedReason: LinkInvalidatedReason | null;
}

export interface PendingMessageInfo {
  id: string;
  state: PendingMessageState;
  body: string;
  createdAt: string;
}

// 阶段2 缺口2/3：A 发送回复的结果。轮次和揭晓状态回写给 A 页面，不让前端自己数。
export interface AReplyResponse {
  message: ChatMessage;
  /** A 的发送内容若触发系统屏蔽，B 收到的是替换后的文本。 */
  contentFilter?: {
    applied: boolean;
    matchedCount: number;
  };
  // false = 本轮没消费掉 B 的问题，按 PRD §5.2 不计轮次
  countedRound: boolean;
  roundCount: number;
  roundLimit: number;
  session: SessionSummary;
}

export interface HeartbeatResponse {
  ok: true;
  lastOwnerHeartbeatAt: string | null;
  serverTime: string;
}

export interface CreateSessionResponse {
  session: SessionSummary;
  publicPath: string;
  // 阶段3：能直接发给 B 的完整链接。没公网时退到本机地址，绝不跳给 B（UI 必须标清来源）。
  publicUrl: string;
  publicUrlSource: PublicUrlSource;
}

export interface SessionDetailResponse {
  session: SessionSummary;
  pending: PendingMessageInfo[];
  messages: ChatMessage[];
  // 阶段2 缺口2：轮次由服务端计数，A 前端不自算（开发文档 §缺口2）
  roundCount: number;
  roundLimit: number;
  // 阶段2 缺口5：倒计时基于服务端时间，前端只算差值
  serverTime: string;
  // 阶段4（PRD §6.6 §9.3 条件5）：这个会话当前有没有生成任务在跑；A 页面用它把按钮置灰。
  generating: boolean;
}

export interface PublicSessionResponse {
  session: Pick<SessionSummary, "id" | "state" | "revealState" | "revealedAt">;
  // 未揭晓时 B 只能看到“虚构 AI”的人设，看不到 A 的真实身份（PRD §5.1）
  aiName: string;
  avatarId: string;
  /** A 给这个假 AI 上传的头像（data URL）；空串 = 用打包进前端的默认图（DEFAULT_AI_AVATAR_FILE）。 */
  avatarData: string;
  openingMessage: string;
  reveal: RevealInfo | null;
  messages: ChatMessage[];
  // 两个上限：B 刷新页面时是从这里重建 preview 的，文案要用的数也在这儿拿。
  roundLimit: number;
  timeLimitMinutes: number;
}

// B 轮询响应：新消息 + 会话状态 + 揭晓信息（PRD §5.3 靠轮询触发弹窗）。
export interface PollResponse {
  messages: ChatMessage[];
  session: Pick<SessionSummary, "id" | "state" | "revealState" | "revealedAt">;
  completedRounds: number;
  roundLimit: number;
  reveal: RevealInfo | null;
}

// 阶段2 缺口1：单B绑定。
export interface ClaimResponse {
  ok: true;
}

// ---------- 阶段2 缺口3/4/5 新增类型 ----------

// 本机设置（PRD §16.4）：与聊天内容无关的本机身份与默认揭晓留言。
export interface LocalProfile {
  ownerName: string;
  ownerAvatarId: string;
  /** A 自己上传的身份头像（data URL，空串=用内置头像）。只在揭晓后出现在 B 侧载荷里。 */
  ownerAvatarData: string;
  defaultRevealMessage: string;
}

// 创建窗口当场填的内容（PRD §7.1），不落在设置表里。
export interface CreateSessionRequest {
  aiName: string;
  /**
   * 保留字段：内置四个编号（robot-01…04）对假 AI 这一侧已经没有界面入口了，
   * 只有老调用方/测试还在送；不送时服务端按 DEFAULT_CREATE 落 robot-01。
   * 展示口径只看 avatarData + 打包进去的默认图。
   */
  avatarId?: string;
  /** 上传的假 AI 头像（data URL，前端压到 256 以内）；不合法当没传，退回默认图。 */
  avatarData?: string;
  openingMessage: string;
  revealMessage?: string;
}

// 创建会话时从本机设置快照下来的身份与文案（PRD §16.2：快照到会话行，
// 之后 A 改设置不影响已发出去的链接）。
export interface SessionProfile {
  aiName: string;
  avatarId: string;
  /** 假 AI 的上传头像；空串表示用打包进去的那张默认图（PRD §7.1）。 */
  avatarData: string;
  openingMessage: string;
  revealMessage: string;
  ownerName: string;
  // A 自己的头像编号：只在揭晓后出现，虚构 AI 的 avatarId 全程可见
  ownerAvatarId: string;
  /** 同上，创建会话那一刻从设置里快照过来；A 之后换头像不影响已发出去的链接（PRD §16.2）。 */
  ownerAvatarData: string;
}

// 揭晓信息：只在 reveal_state=REVEALED 后出现在 B 侧响应里（PRD §7.5）。
export interface RevealInfo {
  state: RevealState;
  reason: RevealReason;
  ownerName: string;
  avatarId: string;
  /** A 上传的身份头像（data URL）；空串时 B 端退回 avatarId 的内置头像。 */
  avatarData: string;
  message: string;
  revealedAt: string | null;
}

// B 绑定前的预览（PRD §17.2 preview）：不绑定也能看到的名字/头像/开场白。
export interface PreviewResponse {
  aiName: string;
  avatarId: string;
  /** 同 PublicSessionResponse：空串时 B 端用 /ai-avatar.jpg 那张默认图。 */
  avatarData: string;
  openingMessage: string;
  state: SessionState;
  // 两个上限随预览下发：B 端的揭晓原因文案要用它们拼（“聊满了 10 轮”/“到了 20 分钟”）。
  roundLimit: number;
  timeLimitMinutes: number;
}

export interface MaintenanceActions {
  revealed: Array<{ sessionId: string; reason: RevealReason }>;
  cleaned: Array<{ sessionId: string; cause: "HEARTBEAT_TIMEOUT" | "EXPIRED" }>;
  scanned: number;
}

// ---------- 阶段3：公网通道（PRD §10 §6.4 §17.1）----------

export type PublicUrlSource = "tunnel" | "config" | "local-dev";

// 对外文案（PRD §6.4：准备中 / 在线 / 重连中 / 不可用）全部由前缀映射，不另开状态。
export type TunnelStatus =
  // 配了 PUBLIC_URL_PATTERN 或显式关了隧道：不进管理器
  | "DISABLED"
  // 未启动（用户停了，或启动失败后未重试）
  | "STOPPED"
  | "STARTING"
  | "ONLINE"
  // 意外退出/健检失败，正在退避重连
  | "RECONNECTING"
  // 重试用完，需要人动手
  | "UNAVAILABLE";

export type TunnelProviderKind = "cloudflared" | "command";

export interface TunnelSnapshot {
  status: TunnelStatus;
  provider: TunnelProviderKind | null;
  publicBaseUrl: string | null;
  publicUrlSource: PublicUrlSource;
  // 给 Ａ 看的中文短句（不夹第三方进程 stderr，防泄露）
  error: string | null;
  reconnects: number;
  /** 本轮进程里「分到过地址、随后又掉」的轮数。它是无限重连的看门狗计数，
   *  到 tunnelMaxUrlCycles 就转 UNAVAILABLE，不再默默重连。 */
  urlCycles: number;
  /** 最近一次隧道客户端退出的脱敏情形。sawUrl=false 是「还没分到地址就退了」
   *  （多为上游分配慢/超时），true 是「拿到过地址又掉」——两种给用户的解释不一样。 */
  lastClientExit: {
    code: number | null;
    signal: string | null;
    sawUrl: boolean;
  } | null;
  // 地址是否真的验证可访问过（PRD 阶段3：复制按钮看这个，不看 status）
  reachable: boolean;
  /** 本机探活没通过、但隧道确实给了地址时，地址照样交出来放在这里。
   *  publicBaseUrl 的语义不能动（那条是「可以直接发给 B」的门槛，见 effectiveBase），
   *  可本机能解析不通自己域名（代理/DNS 分流）的机器上，地址往往是好的 —— 原来两档都不给，
   *  A 就只能看到一个 127.0.0.1，什么都发不出去。这一档让 A 至少能自己先试。
   *  验证通过后为 null。 */
  pendingBaseUrl: string | null;
  // 最近一次探活时间（null = 还从没探过）
  checkedAt: string | null;
  /** 最近一次探活失败的类型（DNS/PROXY/TIMEOUT/HTTP_状态码…）；可达或没探过为 null。域名一律不外泄。 */
  probeError: string | null;
  // 当前状态进入时间 / 本次上线时间
  since: string;
  onlineSince: string | null;
  // 上一次因为公网中断而被迫结束会话的时间（PRD §6.4“原链接是否已失效”）
  linkInvalidatedAt: string | null;
  sessionsCleaned: number;
}

export interface LocalStatusResponse {
  serverTime: string;
  tunnel: TunnelSnapshot;
  /** 阶段4：AI 能力的生效状态（模式/开关/Skill/模型）。A 页面用它决定按钮灰不灰、灰的原因。 */
  assist?: AssistStatusBlock;
  sessions: { live: number };
  policy: TunnelPolicy;
  /** 本机 B 端口：隧道还没建起来时，A 页面上要拿它拼一个只能自己点的地址 */
  /** B 入口的本机端口：没有公网地址时，A 界面用它拼出「只有这台电脑能打开」的地址 */
  localPublicPort: number;
}

// 给路由用的结构型接口：既能接真 TunnelManager，也能接测试里的假货。
export interface TunnelManagerLike {
  snapshot(): TunnelSnapshot;
  // start() 返回 Promise<unknown>：TunnelManager 会回一份快照，注入的假实现回 void 也算合规
  start(): Promise<unknown>;
  stop(): unknown;
  reconnect(): Promise<unknown>;
  // 只重新探活一次（不换域名、不作废旧链接），给本机网络刚恢复时用。
  recheck(): Promise<unknown>;
  dispose(): void;
}

export interface TunnelActionResponse {
  ok: true;
  // 回整份状态而不是只回隧道：点完按钮 A 还要顺带刷新链接可复制性与会话数。
  status: LocalStatusResponse;
}

// 隧道断开超此秒数就会结束会话（PRD §5.1）；进 /api/local/status 是为了让 A 页面能展示同一阈值。
export interface TunnelPolicy {
  downGraceSeconds: number;
  maxReconnectAttempts: number;
  /** 「分到过地址又掉」最多几轮（到点转 UNAVAILABLE，等用户手点）。 */
  maxUrlCycles: number;
  /** 连续掉线达到 maxReconnectAttempts 之前，什么情况下预算会被还回去 ——
   *  A 界面那句「最多试 N 次」必须带上这个，否则数字对不上现象：
   *  链路一旦稳住，计数就归零，于是看着像「试了十几次还没死」。 */
  resetAfterStableSeconds: number;
}

// ---------- 阶段4：AI 能力（PRD §6.5 §6.6 §8 §9）----------

export type AssistMode = "manual" | "rules" | "user_model";

/** AI 味强度，与「增加ai味」Skill 的档位表同名（§9.5 style_level 原样回显）。 */
export type StyleLevel = "轻微" | "明显" | "浓郁";

export type AssistFeature = "AI_STYLE" | "ANALYSIS_SUMMARY";

// Skill 状态（PRD §9.2）：路径缺失或文件无效时只禁用对应按钮，人工聊天照常。
export type SkillStatus = "ok" | "missing" | "invalid" | "disabled";

export interface SkillState {
  feature: AssistFeature;
  /** 配置里声明的仓库相对路径；非法路径原样回显给 A，便于改配置文件（A 端口不出本机）。 */
  configuredPath: string | null;
  status: SkillStatus;
  /** 给 A 看的中文原因；不含绝对路径与文件内容。 */
  reason: string | null;
  skillId: string | null;
  skillVersion: string | null;
  contentHash: string | null;
}

// §9.5 通用调用契约里的 skills[] 元素。
export interface SkillRef {
  feature: AssistFeature;
  skillId: string;
  skillVersion: string;
  contentHash: string;
}

// §9.5 适配器入参。
export interface AssistContract {
  mode: "rewrite" | "analysis" | "both";
  draft: string;
  pendingQuestion: string;
  recentMessages: Array<{ role: "a" | "b"; body: string }>;
  skills: SkillRef[];
  constraints: {
    preserveFacts: true;
    maxReplyChars: number;
    maxAnalysisChars: number;
    styleLevel: StyleLevel;
  };
}

// §9.5 适配器出参（模型/Skill 的原始返回形状，未校验）。
export interface AssistRawResult {
  reply: string;
  analysis_summary: string;
  style_level: string;
  scene: string;
  warnings: string[];
}

export interface ProcessRequest {
  draft: string;
  aiStyleEnabled: boolean;
  analysisEnabled: boolean;
  styleLevel?: StyleLevel;
  /** A 覆盖了当前模式（例如临时切回本地规则）；缺省用设置页里的模式。 */
  mode?: AssistMode;
  /**
   * A 在「可分析过程」框里已经自己写好了：非空时直接作为已确认摘要使用，
   * 不再让模型/规则覆盖它（PRD §6.5「可以改，改完要点确认」）。
   * 仍然要过同一套输出闸（内部用词、Markdown、长度）。
   */
  analysisManual?: string;
}

export interface ProcessResponse {
  processId: string;
  /** 回填 A 正文框的内容：AI 味关闭时逐字等于草稿（§9.5）。 */
  reply: string;
  /** 回填 A 摘要框的内容：摘要关闭时为空串（§9.5）。 */
  analysisSummary: string;
  styleLevel: StyleLevel;
  scene: string | null;
  warnings: string[];
  meta: {
    mode: AssistMode;
    skillRefs: SkillRef[];
    latencyMs: number;
    /** 本次一共问了几次上游：two_step = 2，merged / rules = 1。 */
    calls: number;
  };
}

// 模型设置的可读视图：永远不含密钥（PRD §9.4/§25.8）。
export interface ModelSettingsView {
  mode: AssistMode;
  baseUrl: string;
  modelId: string;
  hasKey: boolean;
  /** 密钥来源，便于 A 知道现在用的是哪一份：env = 启动时从环境读入；manual = 设置页填的。 */
  keySource: "env" | "manual" | null;
}

export interface ModelSettingsRequest {
  baseUrl?: string;
  modelId?: string;
  apiKey?: string;
  mode?: AssistMode;
}

/**
 * 处理草稿失败时的类型码（HTTP 体里的 `error` 字段，PRD §8.3 / §9.5）。
 * 放在共享契约里是故意的：A 端那张「码 → 人话」的表按这个类型**穷举**，
 * 新加一个码而忘了配文案，build 就直接失败。实跑撞过两次串味：
 * 所有失败一起被说成「点得太快了」，以及地址错被说成「还没配密钥」。
 */
export type AssistFailureCode =
  | "DRAFT_EMPTY"
  | "SKILL_MISSING"
  /** 三项凭证真没填齐（getCredentials() 为空）。只此一种情况才许说「还没配密钥」。 */
  | "MODEL_NOT_CONFIGURED"
  /** 填了但不对：地址填法、模型名、URL 合法性。和「没填」必须分开。 */
  | "MODEL_CONFIG_INVALID"
  | "MODEL_UNAVAILABLE"
  /** 思考模型把输出预算花在思考上，正文回不来（PRD §9.5）。 */
  | "MODEL_OUTPUT_TRUNCATED"
  | "RATE_LIMITED"
  | "INVALID_MODEL_OUTPUT";

/**
 * 「处置正文」这一次调用**能返回的全部失败码** = 编排层的码 + 路由自己的码。
 * A 端那张「码 → 人话」的表按这个类型穷举：漏一个码，前端 build 就失败，
 * 界面上就不会再出现只有「处理失败。」四个字的情况。
 */
export type ProcessErrorCode =
  | AssistFailureCode
  | "MANUAL_MODE"
  | "NO_PENDING_MESSAGE"
  | "GENERATION_IN_PROGRESS"
  | "LINK_INVALIDATED"
  | "NOTHING_TO_ENABLE"
  | "INVALID_BODY"
  | "INTERNAL_ERROR";

export interface ModelTestResponse {
  ok: boolean;
  /** 失败类型码；绝不回传供应商响应体（§18.6）。 */
  /** MODEL_CONFIG_INVALID = 填了但不对（地址填法 / 模型名 / URL 不合法）；
   *  MODEL_NOT_CONFIGURED = 三项没填齐。两者必须分开，否则界面会把地址错说成「没配密钥」。 */
  errorCode?:
    | "MODEL_NOT_CONFIGURED"
    | "MODEL_CONFIG_INVALID"
    | "MODEL_UNAVAILABLE"
    | "RATE_LIMITED";
  kind?:
    | "AUTH"
    | "NETWORK"
    | "TIMEOUT"
    | "BAD_RESPONSE"
    | "BAD_ENDPOINT"
    | "BAD_REQUEST"
    | "NOT_CONFIGURED"
    | "TRUNCATED"
    | "RATE_LIMIT"
    | "CONFIG";
  /** 上游状态码与实际请求路径：这两样能定位「地址填错了」，且都不含凭证与正文。 */
  httpStatus?: number;
  endpointPath?: string;
  /** 失败响应像什么：空 / 网页 / 纯文本 / JSON（只是分类标签）。 */
  bodyKind?: "empty" | "html" | "text" | "json";
  /** 实际请求的完整地址（不含密钥）。只回给本机 A 核对配置，不进日志、不进任何 B 侧响应。 */
  endpointUrl?: string;
  /** 同主机不带密钥探到的真接口前缀（能探到时才给）：A 拿到的是「改成这个」，不是一句规劝。 */
  suggestedBaseUrl?: string;
  /** 本次测的是哪套地址（通了也给）：让「测试成功」不再可能被读成「已保存」。 */
  testedBaseUrl?: string;
  /** true = 测的是界面上未保存的草稿值；false = 测的是内存里已保存的那套。 */
  drafted?: boolean;
  message?: string;
  latencyMs?: number;
  modelId?: string;
}

// /api/local/status 的 AI 能力块（A 界面用它决定按钮灰不灰、灰的原因）。
export interface AssistStatusBlock {
  mode: AssistMode;
  aiStyleEnabled: boolean;
  analysisEnabled: boolean;
  styleLevel: StyleLevel;
  skills: { aiStyle: SkillState; analysis: SkillState };
  model: ModelSettingsView;
  limits: {
    maxReplyChars: number;
    maxAnalysisChars: number;
    perMinute: number;
    minIntervalSeconds: number;
  };
}

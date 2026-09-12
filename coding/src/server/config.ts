import { parse as parseEnv } from "dotenv";
import path from "node:path";
import fs from "node:fs";

// 环境变量优先级：shell 里导出的 > .env.local > .env.example（非空值） > 代码里的默认值。
//
// 为什么连 .env.example 也读：它是本项目的“默认值清单”，很多键只有示例文件里有。
// 如果服务端只认 .env.local，那些默认值就成了写了不生效的摆设。
// 阶段4 起约定收紧：**模型密钥等真实凭据一律写 .env.local**，示例文件里那一行必须留空（PRD §9.4）。
//
// 为什么不直接用 dotenv 的 load：它默认「已存在的 process.env 优先」，而 .env.example 是模板，
// 里面写着 KEY= 这种空值。一旦先加载，这个空串就成了「已存在」，后加载的 .env.local
// （以及 npm run prepare-cloudflared 写进去的 CLOUDFLARED_PATH）反而盖不上去。
// 所以这里自己解析：只注入「键名非空」的值，且绝不覆盖 shell 里导出的变量。
const ENV_FILES = {
  example: [
    path.resolve(process.cwd(), "..", ".env.example"),
    path.resolve(process.cwd(), ".env.example"),
  ],
  local: [
    path.resolve(process.cwd(), "..", ".env.local"),
    path.resolve(process.cwd(), ".env.local"),
  ],
};

// 本进程启动时就存在的变量（含 shell 导出的）一律不动。
const inherited = new Set(Object.keys(process.env));

function applyEnvFile(kind: "example" | "local", file: string): void {
  if (!fs.existsSync(file)) return;
  const parsed = parseEnv(fs.readFileSync(file, "utf8"));
  for (const [name, value] of Object.entries(parsed)) {
    const text = value?.trim() ?? "";
    if (!text) continue; // 模板里的空值等于没填，不参与注入也不参与覆盖
    if (inherited.has(name)) continue; // shell 导出的最大
    if (kind === "local" || process.env[name] === undefined)
      process.env[name] = text;
  }
}

for (const file of ENV_FILES.example) applyEnvFile("example", file);
for (const file of ENV_FILES.local) applyEnvFile("local", file);

/**
 * 这个键是不是在 shell 里真实导出过（而不是从 .env.example / .env.local 注入的）。
 * 阶段5 的启动器把一次性控制令牌经**子进程环境变量**传进来，判据就是它；
 * 往 .env 文件里手写令牌在生产模式下永远不认（PRD §12.3 要求每次启动随机）。
 */
export function fromShellEnv(name: string): boolean {
  return inherited.has(name);
}

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

// 枚举型环境变量：填错了回到默认值而不是启动失败（A 改 .env.example 时拼错很常见）。
function oneOf<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = (raw ?? "").trim();
  return (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  localPort: readInt("LOCAL_PORT", 8787),
  publicPort: readInt("PUBLIC_PORT", 8788),
  // A 入口只允许本机访问；B 入口可被局域网/隧道访问（阶段一先监听 0.0.0.0，隧道接入见阶段三）。
  localHost: process.env.LOCAL_HOST ?? "127.0.0.1",
  publicHost: process.env.PUBLIC_HOST ?? "0.0.0.0",
  localDataPath: process.env.LOCAL_DATA_PATH ?? "./data/dev.sqlite",
  logLevel: process.env.LOG_LEVEL ?? "info",

  // ---------- 阶段2：轮次 / 揭晓 / 心跳 / 过期（PRD §5.2 §5.3 §10 §16.6）----------
  // 全部可用环境变量覆盖，测试里需要把时间常量缩短。
  roundLimit: readInt("ROUND_LIMIT", 10),
  // 创建满 N 分钟自动揭晓。2026-09-12 作者要求从 10 改成 20（一轮玩笑 10 分钟不够聊）。
  // 注意：这个数不能只在代码里改——A/B 两个页面都有「距创建已满 N 分钟」这类文案，
  // 原先写死在标签里。现在随载荷下发（SessionSummary.timeLimitMinutes / PreviewResponse），
  // 文案跟着数字走，以后再改环境变量不会把界面上的说法留在旧值上。
  timeLimitMinutes: readInt("TIME_LIMIT_MINUTES", 20),
  heartbeatIntervalSeconds: readInt("HEARTBEAT_INTERVAL_SECONDS", 5),
  heartbeatGraceSeconds: readInt("HEARTBEAT_GRACE_SECONDS", 15),
  sessionExpiryHours: readInt("SESSION_EXPIRY_HOURS", 10),
  // 后台维护器扫描间隔（与心跳发送间隔是两个东西：前者服务端扫，后者 A 页面发）
  maintenanceIntervalMs: readInt("MAINTENANCE_INTERVAL_MS", 2000),

  // ---------- 阶段3：公网通道（PRD §10）----------
  // 已确定公网基址（自备隧道 / 固定域名）时填这个；填了就完全不再进本地隧道管理器。
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? "").trim().replace(/\/+$/, ""),
  // 自备隧道命令（PRD §10.2 P1）：空 = 用内置的 cloudflared Quick Tunnel（P0）。
  tunnelCommand: (process.env.PUBLIC_TUNNEL_COMMAND ?? "").trim(),
  // 从自备命令输出里提取 URL 的正则（带一个捕获组）；不配就用通用的 https:// 子串提取。
  // 环境变量名统一用 PUBLIC_URL_PATTERN（PUBLIC_URL_REGEX 作为旧名兼容读一下）。
  tunnelUrlPattern: (
    process.env.PUBLIC_URL_PATTERN ??
    process.env.PUBLIC_URL_REGEX ??
    ""
  ).trim(),
  // cloudflared 二进制路径；空 = 先找 ./bin/cloudflared（prepare 脚本装的位置），再回退 PATH。
  cloudflaredPath: (process.env.CLOUDFLARED_PATH ?? "").trim(),
  tunnelAutostart: readBool("TUNNEL_AUTOSTART", true),
  // 隧道断开超过这个秒数，本次会话就必须结束（PRD §5.1：公网中断超 15 秒同样结束会话）。
  tunnelDownGraceSeconds: readInt("TUNNEL_DOWN_GRACE_SECONDS", 15),
  tunnelConnectTimeoutMs: readInt("TUNNEL_CONNECT_TIMEOUT_MS", 45_000),
  tunnelHealthTimeoutMs: readInt("TUNNEL_HEALTH_TIMEOUT_MS", 5_000),
  tunnelMaxReconnectAttempts: readInt("TUNNEL_MAX_RECONNECT_ATTEMPTS", 5),
  // 「分到过地址又掉」最多算几轮。跟上面那个预算分开计，是因为它们的根因不同：
  // 一个是压根拿不到地址，一个是拿到了稳不住 —— 后者每次还会作废 A 发出去的链接。
  tunnelMaxUrlCycles: readInt("TUNNEL_MAX_URL_CYCLES", 6),
  // 曾经可达之后，连续探活失败几次算真断线（PRD §10：探活只用于发现“地址在但服务不通”）。
  tunnelHealthFailThreshold: readInt("TUNNEL_HEALTH_FAIL_THRESHOLD", 3),

  // B 静态页面目录：隧道的目标是 B 公开入口，那个入口得能把 B 页面发出去。
  bFrontendDistPath:
    (
      process.env.B_FRONTEND_DIST ??
      process.env.B_FRONTEND_DIST_PATH ??
      ""
    ).trim() || "apps/b-frontend/dist",

  // ---------- 阶段5：启动脚本与本机页面服务（PRD §6.1 §12.2）----------
  // A 工作台的构建产物目录。启动脚本跑的是「服务端直接发页面」，不再依赖 Vite dev server。
  aFrontendDistPath:
    (
      process.env.A_FRONTEND_DIST ??
      process.env.A_FRONTEND_DIST_PATH ??
      ""
    ).trim() || "apps/a-frontend/dist",
  // 工作台跳转地址：留空 = A 页面由本进程发时跳同源的 "/"，否则退回下面的 Vite dev 地址。
  aWorkbenchUrl: (process.env.A_WORKBENCH_URL ?? "").trim(),
  // 本机自检台（阶段5 验收页）：只挂在 A 入口，默认开；SELFTEST_PAGE=0 关掉。
  selftestPage: readBool("SELFTEST_PAGE", true),
  selftestHtmlPath:
    (process.env.SELFTEST_HTML_PATH ?? "").trim() || "static/selftest.html",

  // A 工作台地址：只用于 bootstrap 成功后把人跳回工作台。
  // 强制把 localhost 写成 127.0.0.1：控制会话 Cookie 是按 hostname 分的，
  // 用 localhost 打开工作台会拿到一个“看似已登录但Cookie 不匹配”的诡异状态。
  aFrontendDevUrl: (process.env.A_FRONTEND_DEV_URL ?? "http://localhost:5173")
    .replace("//localhost:", "//127.0.0.1:")
    .replace(/\/+$/, ""),

  // ---------- 阶段4：AI 能力（PRD §6.6 §8 §9）----------
  // Skill 相対路径的解析根（config/skills.json 所在目录）。服务端 cwd 是 coding/，所以默认上一级。
  projectRoot: path.resolve(
    (process.env.PROJECT_ROOT ?? path.join(process.cwd(), "..")).trim(),
  ),
  // 首次启动的生成模式；运行期以 local_settings.model_mode 为准（§9.1：本地规则默认可用）。
  assistMode: oneOf(
    process.env.ASSIST_MODE,
    ["manual", "rules", "user_model"],
    "rules",
  ),
  modelBaseUrl: (process.env.USER_MODEL_BASE_URL ?? "")
    .trim()
    .replace(/\/+$/, ""),
  modelId: (process.env.USER_MODEL_ID ?? "").trim(),
  // 密钥：只在启动时读进内存（src/model/credentials.ts），永不回写文件、永不进日志/响应。
  modelApiKey: (process.env.USER_MODEL_API_KEY ?? "").trim(),
  modelApiStyle: oneOf(
    process.env.USER_MODEL_API_STYLE,
    ["openai", "auto"],
    "openai",
  ),
  modelTimeoutMs: readInt("MODEL_TIMEOUT_MS", 30_000),
  modelRetryTimes: readInt("MODEL_RETRY_TIMES", 2),
  modelTemperature: Number(process.env.MODEL_TEMPERATURE ?? 0.4) || 0.4,
  modelMaxTokens: readInt("MODEL_MAX_TOKENS", 900),
  // 推理模型的自愈预算：正文被思考吃空（finish_reason=length）时换这个值重试一次。
  // 上限不是承诺：默认 900 对非思考模型够用，对带思考字段的模型一定不够（实跑验证 4000 才稳）。
  // 填 0 = 关掉自愈（只报 TRUNCATED，不再花第二次钱）。
  modelMaxTokensEscalate: readInt("MODEL_MAX_TOKENS_ESCALATE", 4000),
  // two_step = 先改写再反推摘要（默认，两个 Skill 各自是自己那一半的权威）；
  // merged = 一次调用出两字段（两份 SKILL.md 同装 system，便宜一轮但难定位）。
  modelCallMode: oneOf(
    process.env.MODEL_CALL_MODE,
    ["two_step", "merged"],
    "two_step",
  ),
  // 同一进程内允许的并发上游请求数；默认串行，避免一个页面拖动把上游打到限流。
  modelMaxConcurrency: readInt("MODEL_MAX_CONCURRENCY", 1),
  // §24.4 限速：模型调用有真金白银成本，阶段 1~3 一条限速都没做，本阶段补上。
  processMinIntervalSeconds: readInt("PROCESS_RATE_LIMIT_SECONDS", 3),
  processPerMinute: readInt("PROCESS_RATE_LIMIT_PER_MINUTE", 6),
  // §5.5 文本上限（写成配置只为测试里能缩短，产品值不要改）。
  maxReplyChars: readInt("MAX_REPLY_CHARS", 500),
  // 改写涨幅上限：正文长度超过「草稿 + N 字」且超过「草稿 × 倍率」时，
  // 判定为模型在替 A 回答问题，而不是在润色 A 的话（真上游跑出来的分界，见阶段4冒烟文档）。
  maxReplyGrowthChars: readInt("REPLY_MAX_GROWTH_CHARS", 80),
  maxReplyGrowthRatio: Number(process.env.REPLY_MAX_GROWTH_RATIO ?? "2.5"),
  maxAnalysisChars: readInt("MAX_ANALYSIS_CHARS", 300),
  // §8.2：传给外部模型的历史上限（单位是“已完成轮次”，一轮 = 一问一答两条）。
  modelContextRounds: readInt("MODEL_CONTEXT_ROUNDS", 10),
};

export type AppConfig = typeof config;

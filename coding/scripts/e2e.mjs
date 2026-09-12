#!/usr/bin/env node
// 端到端冒烟（阶段1~4 全链路，不含公网隧道）：
// 自己用空闲端口起 A/B 两个入口，按真实 HTTP 请求走一遍产品主流程。
//
// 和 vitest 的分工：vitest 用 app.fetch() 验单个路由的行为；这个脚本验的是
// 「真端口 + 真进程 + 两个 server 同时跑 + Cookie 真的能串起来 + 后台维护器真的会动」。
// 隧道部分单独放在 e2e-tunnel.mjs（需要联网，不放进 npm test）。
//
// 用法：npm run e2e
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];

function check(label, ok, extra) {
  const suffix =
    extra === undefined
      ? ""
      : ` → ${typeof extra === "string" ? extra : JSON.stringify(extra)}`;
  console.log(`${ok ? "✅" : "❌"} ${label}${suffix}`);
  if (!ok) failures.push(label);
}

async function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(url, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  return false;
}

const localPort = Number(process.env.E2E_LOCAL_PORT ?? (await freePort()));
const publicPort = Number(process.env.E2E_PUBLIC_PORT ?? (await freePort()));
const token = process.env.E2E_TOKEN ?? "e2e-local-control-token-0123456789";
const dbPath = path.join(ROOT, "data", `e2e-${Date.now()}.sqlite`); // 独立库文件：绝不碰开发用的 data/dev.sqlite

const LOCAL = `http://127.0.0.1:${localPort}`;
const PUBLIC_LOCAL = `http://127.0.0.1:${publicPort}`;

let childLog = "";
function startServer() {
  const proc = spawn("npx", ["tsx", "src/server/index.ts"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      LOCAL_PORT: String(localPort),
      PUBLIC_PORT: String(publicPort),
      LOCAL_DATA_PATH: dbPath,
      LOCAL_CONTROL_TOKEN_SECRET: token,
      TUNNEL_AUTOSTART: "false", // 本脚本不碰公网；隧道部分见 npm run e2e:tunnel
      // 显式置空 = 屏蔽 .env.local 里的真实模型凭证（inherited 的键文件盖不上来）。
      // 冒烟必须与开发机上有没有填 key 无关，否则同一份脚本在别人机器上结论不同。
      USER_MODEL_BASE_URL: "",
      USER_MODEL_ID: "",
      USER_MODEL_API_KEY: "",
      MAINTENANCE_INTERVAL_MS: "1000", // 心跳超时/过期这类判定靠后台扫，1s 一轮让冒烟不必等十几秒
      NODE_ENV: "development",
    },
  });
  proc.stdout.on("data", (d) => (childLog += d.toString()));
  proc.stderr.on("data", (d) => (childLog += d.toString()));
  return proc;
}
let child = startServer();

async function stopServer() {
  const proc = child;
  proc.kill("SIGTERM");
  // 等它真退出：SIGTERM 处理里要清会话、收隧道子进程，没退干净就重启会抢库
  await Promise.race([new Promise((r) => proc.on("exit", r)), sleep(4_000)]);
}

async function stop() {
  child.kill("SIGTERM");
  await sleep(400);
  child.kill("SIGKILL");
  const { rmSync } = await import("node:fs");
  for (const suffix of ["", "-shm", "-wal"]) {
    try {
      rmSync(dbPath + suffix);
    } catch {
      /* 已不存在 */
    }
  }
}

/** 用第二个连接改库：脚本要制造「时间到了」「链接作废了」这两种只能等或只能从外部触发的状态。 */
async function withDb(fn) {
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(dbPath, { verbose: null });
  db.pragma("busy_timeout = 5000");
  try {
    return await fn(db); // 允许脚本用它在库里读点东西做断言
  } finally {
    db.close();
  }
}

// 把响应里出现过的标识符与正文收集起来，最后拿去扫一遍服务端的日志输出：
// PRD §18.6 禁止会话 id、Cookie、令牌进日志，消息正文也不该进。从响应里收集比手写清单可靠 ——
// 新加一个接口、多返回一个 id，也会自动纳入检查。
const seenSecrets = new Set();
// 与 -- 处理草稿最小间隔对齐：限速判定见 §9.3/§24.4。
function config_min_interval_ms() {
  return Number(process.env.E2E_PROCESS_MIN_INTERVAL_MS ?? 3_100);
}

function harvest(text) {
  const body = String(text ?? "");
  for (const m of body.matchAll(
    /"(?:id|sessionId|messageId|claimToken|token)":"([^"]{4,})"/g,
  ))
    seenSecrets.add(m[1]);
  for (const m of body.matchAll(/"body":"([^"]{2,})"/g)) seenSecrets.add(m[1]);
}

/** A 端请求：带 Origin + 控制令牌 Cookie。 */
async function a(url, init = {}) {
  const headers = new Headers({
    origin: LOCAL,
    cookie: `aiwindow_ctrl=${token}`,
    ...init.headers,
  });
  const res = await fetch(LOCAL + url, { ...init, headers });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* 非 JSON（例如 404 纯文本） */
  }
  harvest(text);
  return {
    status: res.status,
    body,
    text,
    cookie: res.headers.get("set-cookie"),
  };
}

/** B 端请求：走 B 入口的公网端口，只带自己的绑定 Cookie。 */
let bCookie = "";
async function b(url, init = {}) {
  const headers = new Headers({ ...init.headers });
  if (bCookie) headers.set("cookie", bCookie);
  const res = await fetch(PUBLIC_LOCAL + url, { ...init, headers });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* 同上 */
  }
  const set = res.headers.get("set-cookie");
  if (set) bCookie = set.split(";")[0];
  harvest(text);
  return { status: res.status, body, text };
}

try {
  console.log(`\nE2E：A ${LOCAL} / B ${PUBLIC_LOCAL}（独立库 ${dbPath}）\n`);
  if (!(await waitForHealth(`${PUBLIC_LOCAL}/api/public/health`))) {
    check("服务启动", false, childLog.slice(-600));
    process.exit(1);
  }
  check("服务启动（B 健康检查可通）", true);

  // ---- 阶段1 底线：两个入口的监听面本来就是不同的（PRD §18.1：A 永不出本机）----
  const { networkInterfaces } = await import("node:os");
  const lanIp = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === "IPv4" && !i.internal)?.address;
  if (!lanIp) {
    console.log("ℹ️  本机没有可用的局域网 IPv4 地址，跳过 A/B 监听面检查");
  } else {
    // 目标写的是字面量 IPv4，不走 DNS，所以不需要额外的解析处理
    try {
      const aViaLan = await fetch(
        `http://${lanIp}:${localPort}/api/local/status`,
        {
          signal: AbortSignal.timeout(3_000),
        },
      ).then((r) => r.status);
      check(
        "A 入口不监听局域网：从局域网 IP 打过去连不上",
        false,
        `居然通了，HTTP ${aViaLan}`,
      );
    } catch {
      check("A 入口不监听局域网：从局域网 IP 打过去连不上", true);
    }
    try {
      const bViaLan = await fetch(
        `http://${lanIp}:${publicPort}/api/public/health`,
        {
          signal: AbortSignal.timeout(3_000),
        },
      );
      check(
        "B 入口监听局域网：同网段设备可打开（默认 0.0.0.0，隧道前的兜底）",
        bViaLan.status === 200,
        bViaLan.status,
      );
    } catch (err) {
      check(
        "B 入口监听局域网：同网段设备可打开（默认 0.0.0.0，隧道前的兜底）",
        false,
        String(err?.code ?? err),
      );
    }
  }

  // ---- bootstrap：地址栏直接打开，无 Origin ----
  const boot = await fetch(`${LOCAL}/api/local/bootstrap/${token}`, {
    headers: { "sec-fetch-site": "none" },
  });
  const bootHtml = await boot.text();
  check(
    "A 端 bootstrap：种 Cookie + 清地址栏令牌 + 跳工作台",
    boot.status === 200 &&
      /aiwindow_ctrl=/.test(boot.headers.get("set-cookie") ?? "") &&
      bootHtml.includes("replaceState") &&
      // 阶段5 起 A 工作台由同一个进程同源发出（跳 "/"），只有没构建产物的纯 Vite 开发流
      // 才跳 5173。两种都算对 —— 别把这条断言改回只认端口号，那等于把同源化退回去。
      (bootHtml.includes('location.replace("/")') ||
        bootHtml.includes(String(Number(process.env.E2E_A_PORT ?? 5173)))),
    boot.status,
  );
  check(
    "bootstrap 令牌一次性：同一令牌再来一次失败",
    (
      await fetch(`${LOCAL}/api/local/bootstrap/${token}`, {
        headers: { "sec-fetch-site": "none" },
      })
    ).status === 403,
  );

  // ---- 设置与创建 ----
  check(
    "保存我的身份（称呼/头像/默认揭晓留言）",
    (
      await a("/api/local/settings/profile", {
        method: "PUT",
        body: JSON.stringify({
          ownerName: "小明",
          ownerAvatarId: "robot-02",
          defaultRevealMessage: "其实刚才是我在打字",
        }),
      })
    ).status === 200,
  );
  check(
    "读回身份",
    (await a("/api/local/settings")).body?.profile?.ownerAvatarId ===
      "robot-02",
    (await a("/api/local/settings")).body,
  );
  const created = await a("/api/local/sessions", {
    method: "POST",
    body: JSON.stringify({
      aiName: "小助手",
      avatarId: "robot-03",
      openingMessage: "在的，你说",
      revealMessage: "其实刚才是我在打字",
    }),
  });
  const id = created.body?.session?.id;
  check("创建会话", created.status === 201 && !!id, created.status);
  check(
    "创建时快照身份（改设置不回写旧会话）",
    created.body?.session?.profile?.aiName === "小助手" &&
      created.body?.session?.profile?.ownerName === "小明",
    created.body?.session?.profile,
  );
  check(
    "未配公网时链接退回本机地址（明确标注来源）",
    created.body?.publicUrlSource === "local-dev" &&
      created.body?.publicUrl?.includes(`:${publicPort}/s/`),
    created.body?.publicUrl,
  );
  check(
    "空 body 也能创建（走默认值）",
    (await a("/api/local/sessions", { method: "POST", body: "" })).status ===
      201,
  );
  const stray = await a("/api/local/sessions", { method: "GET" });
  check(
    "非法头像被拒",
    (
      await a("/api/local/sessions", {
        method: "POST",
        body: JSON.stringify({ avatarId: "nasa" }),
      })
    ).status === 400,
  );
  void stray;

  // ---- B：预览 → 绑定 → 第二设备被拒 ----
  check(
    "B 未绑定可预览（免凭证）",
    (await b(`/api/public/sessions/${id}/preview`)).status === 200,
  );
  const claim = await b(`/api/public/sessions/${id}/claim`, { method: "POST" });
  check(
    "B 绑定成功并拿到凭证",
    claim.status === 200 && !!bCookie,
    claim.status,
  );
  const second = await fetch(
    `${PUBLIC_LOCAL}/api/public/sessions/${id}/claim`,
    { method: "POST" },
  );
  check(
    "第二设备绑定被拒 409",
    second.status === 409 &&
      (await second.json()).error === "LINK_ALREADY_CLAIMED",
    second.status,
  );
  check("B 打 A 的接口一律 404", (await b("/api/local/status")).status === 404);
  check(
    "B 页面静态产物在公网入口可打开",
    (await fetch(`${PUBLIC_LOCAL}/s/${id}`)).status === 200,
  );

  // ---- 一问一答计轮次 ----
  const sent = await b(`/api/public/sessions/${id}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "e2e-b-1",
    },
    body: JSON.stringify({ body: "你会写诗吗" }),
  });
  check("B 发送成功", sent.status === 201, sent.status);
  // PRD §14.3「同 key + 同内容返回第一次结果」：这里比对的是首次响应里那条消息的 id，
  // 状态码沿用首次的 201（阶段1 起就是这个口径，"返回第一次结果"包含状态码，不算偏离）。
  const replay = await b(`/api/public/sessions/${id}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "e2e-b-1",
    },
    body: JSON.stringify({ body: "你会写诗吗" }),
  });
  const bMessages = (
    await b(`/api/public/sessions/${id}/poll`)
  ).body.messages.filter((m) => m.sender === "B");
  check(
    "B 重发同 Key 返回同一条消息、不产生第二条",
    replay.body?.message?.id === sent.body?.message?.id &&
      bMessages.length === 1,
    {
      same: replay.body?.message?.id === sent.body?.message?.id,
      n: bMessages.length,
    },
  );
  check(
    "B 同 Key 改内容被拒 409",
    (
      await b(`/api/public/sessions/${id}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "e2e-b-1",
        },
        body: JSON.stringify({ body: "换个内容" }),
      })
    ).status === 409,
  );

  const aDetail = await a(`/api/local/sessions/${id}`);
  check(
    "A 看到待处理消息",
    aDetail.body.pending.length === 1 && aDetail.body.roundCount === 0,
    JSON.stringify({
      p: aDetail.body.pending.length,
      r: aDetail.body.roundCount,
    }),
  );

  const reply = await a(`/api/local/sessions/${id}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "e2e-a-1",
    },
    body: JSON.stringify({ body: "略懂一二" }),
  });
  check(
    "A 发送计为第 1 轮",
    reply.status === 201 &&
      reply.body.roundCount === 1 &&
      reply.body.countedRound === true,
    reply.body?.roundCount,
  );
  const replyReplay = await a(`/api/local/sessions/${id}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "e2e-a-1",
    },
    body: JSON.stringify({ body: "略懂一二" }),
  });
  check(
    "A 重试同 Key 不重复计数、不重复发消息",
    replyReplay.body?.roundCount === 1 &&
      replyReplay.body?.message?.id === reply.body?.message?.id,
    replyReplay.body?.roundCount,
  );
  const polled = await b(`/api/public/sessions/${id}/poll`);
  check(
    "B poll 到 A 的回复",
    polled.body.messages.some((m) => m.body === "略懂一二"),
    polled.body.messages.length,
  );

  // ---- 心跳 ----
  const hb = await a(`/api/local/sessions/${id}/heartbeat`, { method: "POST" });
  check(
    "A 心跳刷新时间戳",
    hb.status === 200 && !!hb.body?.serverTime,
    hb.status,
  );

  // ---- 满 10 轮自动揭晓 ----
  for (let round = 2; round <= 10; round++) {
    await b(`/api/public/sessions/${id}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `e2e-b-${round}`,
      },
      body: JSON.stringify({ body: `第${round}问` }),
    });
    const r = await a(`/api/local/sessions/${id}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `e2e-a-${round}`,
      },
      body: JSON.stringify({ body: `第${round}答` }),
    });
    if (r.body?.roundCount !== round) {
      check(`第 ${round} 轮计数`, false, r.body?.roundCount);
      break;
    }
  }
  const after10 = await a(`/api/local/sessions/${id}`);
  check(
    "满 10 轮自动揭晓（ROUND_LIMIT）",
    after10.body?.session?.revealReason === "ROUND_LIMIT",
    after10.body?.session?.revealReason,
  );
  const bReveal = await b(`/api/public/sessions/${id}/poll`);
  check(
    "B poll 拿到揭晓内容（真名 + 留言 + 轮数）",
    bReveal.body?.reveal?.ownerName === "小明" &&
      bReveal.body?.reveal?.message === "其实刚才是我在打字" &&
      bReveal.body?.completedRounds === 10,
    bReveal.body?.reveal,
  );
  check(
    "揭晓后会话仍然可用（不关闭、不强制刷新）",
    (await b(`/api/public/sessions/${id}/poll`)).status === 200,
  );

  // ---- 时间到点揭晓（默认 20 分钟；改库触发同一套判定）----
  const other = (await a("/api/local/sessions", { method: "POST", body: "{}" }))
    .body.session.id;
  await a(`/api/local/sessions/${other}/heartbeat`, { method: "POST" });
  // 时间揭晓不真等 20 分钟：把 reveal_deadline_at 挪到过去，让服务端的后台维护器自己扫到。
  // （函数级判定已在 vitest 覆盖，这里要验的是「定时器真的在跑」这件事。）
  await withDb(async (db) => {
    db.prepare(`UPDATE sessions SET reveal_deadline_at = ? WHERE id = ?`).run(
      new Date(Date.now() - 60_000).toISOString(),
      other,
    );
  });
  await sleep(4_000); // 等后台维护器扫一轮（MAINTENANCE_INTERVAL_MS=2000）
  const timeReveal = await a(`/api/local/sessions/${other}`);
  check(
    "创建到点（默认 20 分钟）自动揭晓（TIME_LIMIT）",
    timeReveal.body?.session?.revealReason === "TIME_LIMIT",
    timeReveal.body?.session?.revealReason,
  );

  // ---- A 主动揭晓 ----
  const manual = (
    await a("/api/local/sessions", { method: "POST", body: "{}" })
  ).body.session.id;
  const revealed = await a(`/api/local/sessions/${manual}/reveal`, {
    method: "POST",
  });
  check(
    "A 主动揭晓优先于其它原因",
    revealed.body?.session?.revealReason === "OWNER_ACTION",
    revealed.body?.session?.revealReason,
  );
  check(
    "重复揭晓 409",
    (await a(`/api/local/sessions/${manual}/reveal`, { method: "POST" }))
      .status === 409,
  );

  // ---- 结束并清理 ----
  const closed = await a(`/api/local/sessions/${manual}/close`, {
    method: "POST",
  });
  check("A 结束会话", closed.status === 200, closed.status);
  check(
    "已结束会话 A/B 都 404",
    (await a(`/api/local/sessions/${manual}`)).status === 404 &&
      (await b(`/api/public/sessions/${manual}/poll`)).status === 404,
  );

  // ---- 链接作废（阶段3 善后，不经隧道直接打标记）----
  const victim = (
    await a("/api/local/sessions", { method: "POST", body: "{}" })
  ).body.session.id;
  await fetch(`${PUBLIC_LOCAL}/api/public/sessions/${victim}/claim`, {
    method: "POST",
  });
  // 等价于 markLinksInvalidated("TUNNEL_DOWN") 的落库结果（那个函数本身有 vitest 覆盖）：
  // 这里要验的是「库里一旦有这个标记，B 和 A 各看到什么」。
  await withDb(async (db) => {
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE sessions SET state='CLOSED', link_invalidated_at=?, link_invalidated_reason='TUNNEL_DOWN', updated_at=? WHERE id=?`,
    ).run(now, now, victim);
  });
  const gone = await fetch(
    `${PUBLIC_LOCAL}/api/public/sessions/${victim}/poll`,
  );
  check(
    "链接作废后 B 拿到 410 LINK_INVALIDATED",
    gone.status === 410 && (await gone.json()).error === "LINK_INVALIDATED",
    gone.status,
  );
  check(
    "作废后 A 仍看得到原因（留墓碑）",
    (await a(`/api/local/sessions/${victim}`)).body?.session
      ?.linkInvalidatedReason === "TUNNEL_DOWN",
  );

  // ---- 阶段2 缺口4：A 失联（心跳超时）由后台扫描收尾，不靠前端自觉 ----
  const ghost = (await a("/api/local/sessions", { method: "POST", body: "{}" }))
    .body.session.id;
  await a(`/api/local/sessions/${ghost}/heartbeat`, { method: "POST" });
  await withDb((db) => {
    // 把心跳时间挪到宽限期之前：真等 20 秒会让冒烟变慢且不稳，判超时的算法本身由单测覆盖
    db.prepare(
      `UPDATE sessions SET last_owner_heartbeat_at = ? WHERE id = ?`,
    ).run(new Date(Date.now() - 60_000).toISOString(), ghost);
  });
  await sleep(2_500); // MAINTENANCE_INTERVAL_MS=1000，留两轮
  check(
    "A 心跳超时后会话被后台清理（B 那边也问不到了）",
    (await a(`/api/local/sessions/${ghost}`)).status === 404 &&
      (await b(`/api/public/sessions/${ghost}/poll`)).status === 404 &&
      (
        await withDb((db) =>
          db
            .prepare("SELECT COUNT(*) AS n FROM rounds WHERE session_id = ?")
            .get(ghost),
        )
      ).n === 0,
    (await a(`/api/local/sessions/${ghost}`)).status,
  );

  // ---- 阶段4：AI 能力（处理草稿 / 摘要一致性 / B 侧可见性 / 凭证边界）----
  const FAKE_KEY = "e2fakekey-0123456789abcdef";
  const assist = (
    await a("/api/local/sessions", { method: "POST", body: "{}" })
  ).body.session.id;
  bCookie = "";
  await b(`/api/public/sessions/${assist}/claim`, { method: "POST" });
  const bAsk = (body, key) =>
    b(`/api/public/sessions/${assist}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": key ?? `e2e-a4-${Math.random()}`,
      },
      body: JSON.stringify({ body }),
    });
  const aProcess = (payload) =>
    a(`/api/local/sessions/${assist}/process`, {
      method: "POST",
      body: JSON.stringify(payload),
    });

  await a("/api/local/settings/assist", {
    method: "PUT",
    body: JSON.stringify({
      mode: "rules",
      aiStyleEnabled: true,
      analysisEnabled: true,
      styleLevel: "明显",
    }),
  });

  check(
    "B 连发第二条被锁住（409 MESSAGE_PENDING）",
    (await bAsk("这个方案你倾向于先做界面还是先做数据？具体说理由。"))
      .status === 201 &&
      (await bAsk("那我三分钟后再问一次")).status === 409 &&
      (await b(`/api/public/sessions/${assist}/poll`)).body.messages.filter(
        (m) => m.sender === "B",
      ).length === 1,
  );

  const PROCESS_DRAFT =
    "我倾向先做第一版界面，两周后看数据再定下一步，字段名沿用现在这套。";
  const gen = await aProcess({
    draft: PROCESS_DRAFT,
    aiStyleEnabled: true,
    analysisEnabled: true,
  });
  check(
    "处理草稿（本地规则模式）返回正文 + 摘要 + processId",
    gen.status === 200 &&
      !!gen.body.reply &&
      !!gen.body.analysisSummary &&
      !!gen.body.processId,
    gen.status,
  );
  check(
    "生成的正文保住草稿里的数字",
    gen.body?.reply?.includes("两周") && gen.body?.reply?.includes("第一版"),
    gen.body?.reply,
  );
  check(
    "A 侧标记这条问题已进入回复流程",
    (await a(`/api/local/sessions/${assist}`)).body.pending[0]?.state !==
      "WAITING_A",
    (await a(`/api/local/sessions/${assist}`)).body.pending[0]?.state,
  );
  check(
    "处理草稿有最小间隔：立刻再点拿 429",
    (
      await aProcess({
        draft: PROCESS_DRAFT,
        aiStyleEnabled: true,
        analysisEnabled: true,
      })
    ).status === 429,
  );

  const staleSend = await a(`/api/local/sessions/${assist}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "e2e-a4-stale",
    },
    body: JSON.stringify({
      body: `${gen.body.reply} 我又加了一句，没重新处理。`,
      processId: gen.body.processId,
    }),
  });
  check(
    "改过正文没重新确认 → 409 ANALYSIS_STALE（摘要不会跟着错正文发出去）",
    staleSend.status === 409 && staleSend.body?.error === "ANALYSIS_STALE",
    staleSend.status,
  );
  check(
    "闸门没放行时轮次不涨",
    (await a(`/api/local/sessions/${assist}`)).body.roundCount === 0,
    (await a(`/api/local/sessions/${assist}`)).body.roundCount,
  );

  // 等过最小间隔（3 秒）再来，否则拿到的会是限速的 429，测不到摘要那一层。
  await sleep(config_min_interval_ms());
  const bothOff = await aProcess({
    draft: PROCESS_DRAFT,
    aiStyleEnabled: false,
    analysisEnabled: false,
  });
  check(
    "两个开关都关 → 409 NOTHING_TO_ENABLE（不给假成功，也不占限速额度）",
    bothOff.status === 409 && bothOff.body?.error === "NOTHING_TO_ENABLE",
    bothOff.status,
  );
  const manualBlocked = await aProcess({
    draft: PROCESS_DRAFT,
    aiStyleEnabled: true,
    analysisEnabled: true,
    analysisManual: "这是我照着草稿在后台按规则拼的，用了模型和提示词",
  });
  check(
    "A 手写摘要也要过禁词闸 → 422",
    manualBlocked.status === 422,
    manualBlocked.status,
  );

  const goodSend = await a(`/api/local/sessions/${assist}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "e2e-a4-ok",
    },
    body: JSON.stringify({
      body: gen.body.reply,
      processId: gen.body.processId,
    }),
  });
  check(
    "带 processId 且正文一致 → 发送成功并带上摘要",
    goodSend.status === 201 &&
      goodSend.body?.message?.analysisSummary === gen.body.analysisSummary,
    goodSend.status,
  );

  const bSeen = await b(`/api/public/sessions/${assist}/poll`);
  const aBubble = bSeen.body.messages.find((m) => m.sender === "A");
  check(
    "B 看得到摘要（那是它的演出素材）",
    aBubble?.analysisSummary === gen.body.analysisSummary,
    aBubble?.analysisSummary,
  );
  check(
    "B 侧响应里没有模式/Skill/凭证痕迹（PRD §8.3）",
    !("assist" in (aBubble ?? {})) &&
      !/skillRefs|contentHash|processId|"mode"|"styleLevel"|"scene"/i.test(
        JSON.stringify(bSeen.body),
      ),
    JSON.stringify(bSeen.body).slice(0, 120),
  );
  check(
    "摘要文本不含内部用词（草稿/提示词/模型/后台…）",
    !/草稿|提示词|模型|后台|规则模式|skill|token/i.test(
      aBubble?.analysisSummary ?? "",
    ),
    aBubble?.analysisSummary,
  );
  check(
    "B 答完一轮后可以继续问",
    (await bAsk("那数据这块谁来出？")).status === 201,
  );

  await a("/api/local/settings/assist", {
    method: "PUT",
    body: JSON.stringify({ mode: "manual" }),
  });
  check(
    "人工模式下处理草稿直接拒绝（409 MANUAL_MODE）",
    (
      await aProcess({
        draft: "随便一句",
        aiStyleEnabled: true,
        analysisEnabled: true,
      })
    ).status === 409,
  );
  const manualReply = await a(`/api/local/sessions/${assist}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "e2e-a4-manual",
    },
    body: JSON.stringify({ body: "数据我自己出，你给我字段口径就行。" }),
  });
  check(
    "人工原文照常发（无摘要，不碰模型）",
    manualReply.status === 201 &&
      (manualReply.body?.message?.analysisSummary ?? null) === null,
    manualReply.status,
  );

  await a("/api/local/settings/assist", {
    method: "PUT",
    body: JSON.stringify({ mode: "user_model" }),
  });
  await bAsk("界面上第二个入口放哪儿？"); // 上一条已经被人工回复掉了，先攒出一个新问题
  const noCred = await aProcess({
    draft: "这句走模型模式试试。",
    aiStyleEnabled: true,
    analysisEnabled: true,
  });
  check(
    "模型模式没配凭证 → 409 MODEL_NOT_CONFIGURED（不起网络请求）",
    noCred.status === 409 && noCred.body?.error === "MODEL_NOT_CONFIGURED",
    noCred.body?.error,
  );

  await a("/api/local/settings/model", {
    method: "PUT",
    body: JSON.stringify({
      baseUrl: "https://example.invalid/v1",
      modelId: "e2e-model",
      apiKey: FAKE_KEY,
    }),
  });
  const settingsView = await a("/api/local/settings");
  check(
    "设置接口不回显密钥（只回 hasKey）",
    settingsView.body?.model?.hasKey === true &&
      !settingsView.text.includes(FAKE_KEY),
    JSON.stringify(settingsView.body?.model),
  );
  const badUrl = await a("/api/local/settings/model/test", { method: "POST" });
  check(
    "连通性测试失败只回类型码，不回供应商原文",
    badUrl.status === 502 && ["CONFIG", "NETWORK"].includes(badUrl.body?.kind),
    `${badUrl.status}:${badUrl.body?.kind}`,
  );
  await a("/api/local/settings/model", { method: "DELETE" });
  check(
    "清除密钥后 hasKey=false",
    (await a("/api/local/settings")).body?.model?.hasKey === false,
  );

  // ---- 重启：启动清场必须把上一次运行留下的会话删干净（PRD §16.6 / 不留旧链接）----
  const leftover = (
    await a("/api/local/sessions", { method: "POST", body: "{}" })
  ).body.session.id;
  await stopServer();
  child = startServer();
  if (!(await waitForHealth(`${PUBLIC_LOCAL}/api/public/health`))) {
    check("重启服务", false, childLog.slice(-400));
    process.exit(1);
  }
  await fetch(`${LOCAL}/api/local/bootstrap/${token}`, {
    headers: { "sec-fetch-site": "none" },
  });
  check(
    "重启后旧会话不残留（A/B 都 404、库里没有轮次）",
    (await a(`/api/local/sessions/${leftover}`)).status === 404,
    (await a(`/api/local/sessions/${leftover}`)).status,
  );
  const logSecrets = new Set([
    token,
    ...seenSecrets,
    bCookie.split("=")[1] ?? "",
  ]);
  check(
    "服务端日志里没有会话 id / 令牌 / 绑定凭证 / 消息正文（PRD §18.6 底线）",
    (() => {
      const leaked = [...logSecrets, FAKE_KEY].filter(
        (secret) => secret && childLog.includes(secret),
      );
      if (leaked.length)
        console.log(
          `   泄露 ${leaked.length} 个，样本（截断）：${leaked[0].slice(0, 12)}`,
        );
      return leaked.length === 0;
    })(),
    `比对 ${logSecrets.size + 1} 个标识符/正文/密钥，扫 ${childLog.split("\n").length} 行日志`,
  );

  check(
    "重启后 AI 设置仍在（SQLite），但模型密钥随进程蒸发（PRD §8.2）",
    (await a("/api/local/settings")).body?.assist?.mode === "user_model" &&
      (await a("/api/local/settings")).body?.model?.hasKey === false,
    JSON.stringify((await a("/api/local/settings")).body?.model),
  );
  check(
    "重启后状态面板的进行中会话归零",
    (await a("/api/local/status")).body?.sessions?.live === 0,
    (await a("/api/local/status")).body?.sessions,
  );

  console.log(
    failures.length
      ? `\n失败 ${failures.length} 项：${failures.join("、")}`
      : "\n全部通过",
  );
} catch (err) {
  check("脚本异常", false, String(err?.stack ?? err));
  console.log("子进程日志尾部：\n" + childLog.slice(-1_500));
} finally {
  await stop();
}
process.exit(failures.length ? 1 : 0);

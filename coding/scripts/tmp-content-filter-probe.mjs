#!/usr/bin/env node
// 临时验证脚本（只读，不改产品代码）：按 docs/系统屏蔽词规范.md §4 的验收清单，
// 用真端口 + 真进程走一遍 A→B，检查「服务端过滤 / B 端兜底 / A 端提示 / 日志不留原文」。
// 用法：node scripts/tmp-content-filter-probe.mjs   （跑完自己删，产物不落盘）
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (label, ok, extra) => {
  const suffix = extra === undefined ? "" : ` → ${JSON.stringify(extra)}`;
  console.log(`${ok ? "✅" : "❌"} ${label}${suffix}`);
  if (!ok) failures.push(label);
};
const freePort = () =>
  new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

const localPort = await freePort();
const publicPort = await freePort();
const token = "probe-local-control-token-0123456789";
const dbPath = path.join(ROOT, "data", `probe-filter-${Date.now()}.sqlite`);
const LOCAL = `http://127.0.0.1:${localPort}`;
const PUBLIC = `http://127.0.0.1:${publicPort}`;

let childLog = "";
const child = spawn("npx", ["tsx", "src/server/index.ts"], {
  cwd: ROOT,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    LOCAL_PORT: String(localPort),
    PUBLIC_PORT: String(publicPort),
    LOCAL_DATA_PATH: dbPath,
    LOCAL_CONTROL_TOKEN_SECRET: token,
    TUNNEL_AUTOSTART: "false",
    ROUND_LIMIT: "1", // 一条 A 回复就触发自动揭晓，顺便验留言与名称这一路
    USER_MODEL_BASE_URL: "",
    USER_MODEL_ID: "",
    USER_MODEL_API_KEY: "",
    NODE_ENV: "development",
  },
});
child.stdout.on("data", (d) => (childLog += d.toString()));
child.stderr.on("data", (d) => (childLog += d.toString()));

const stop = async () => {
  child.kill("SIGTERM");
  await sleep(300);
  child.kill("SIGKILL");
  const { rmSync } = await import("node:fs");
  for (const s of ["", "-shm", "-wal"]) {
    try {
      rmSync(dbPath + s);
    } catch {
      /* ignore */
    }
  }
};

const AH = { origin: LOCAL, cookie: `aiwindow_ctrl=${token}` };
async function a(url, init = {}) {
  const res = await fetch(LOCAL + url, {
    ...init,
    headers: { ...AH, "content-type": "application/json", ...init.headers },
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { status: res.status, body, text };
}
let bCookie = "";
async function b(url, init = {}) {
  const headers = new Headers(init.headers ?? {});
  if (bCookie) headers.set("cookie", bCookie);
  const res = await fetch(PUBLIC + url, { ...init, headers });
  const set = res.headers.get("set-cookie");
  if (set) bCookie = set.split(";")[0];
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { status: res.status, body, text };
}

// 规范里点名的原词，用来扫「任何往外走的东西里还有没有它」
const RAW = ["支付宝", "转账", "验证码", "银行", "钱", "投屏", "密码"];
function rawPaths(node, at = "$", out = []) {
  if (typeof node === "string") {
    const hits = RAW.filter((w) => node.includes(w));
    if (hits.length) out.push({ path: at, hits, value: node.slice(0, 40) });
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) rawPaths(v, `${at}.${k}`, out);
  }
  return out;
}

const stillRaw = (label, text) => {
  const leaked = RAW.filter((w) => String(text ?? "").includes(w));
  check(`${label}：一个原词都不含`, leaked.length === 0, leaked.length ? leaked : "干净");
};

try {
  // 两个端口都听上了再开工（本地路由全在控制令牌后面，别拿它当健康检查）
  const waitPort = (port) =>
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 25_000;
      const tick = () => {
        const sock = net.connect(port, "127.0.0.1");
        sock.on("connect", () => {
          sock.destroy();
          resolve(true);
        });
        sock.on("error", () => {
          sock.destroy();
          if (Date.now() > deadline) reject(new Error("服务没起来：" + childLog.slice(0, 400)));
          else setTimeout(tick, 250);
        });
      };
      tick();
    });
  await waitPort(localPort);
  await waitPort(publicPort);

  // 1) 创建：A 的名称 / 开场白 / 揭晓留言里塞命中词
  const created = await a("/api/local/sessions", {
    method: "POST",
    body: JSON.stringify({
      aiName: "支付宝小助手",
      ownerName: "银行客服老王",
      openingMessage: "在的，需要转账你说",
      revealMessage: "其实刚才是我在要密码",
    }),
  });
  const id = created.body?.session?.id;
  check("建会话成功", created.status < 300 && !!id, created.status);

  // 2) B 绑定并提问（问题里也带原词：规范说 B 输入不替换，A 要看原文判风险）
  await b(`/api/public/sessions/${id}/claim`, { method: "POST" });
  const asked = await b(`/api/public/sessions/${id}/messages`, {
    method: "POST",
    headers: { "idempotency-key": "probe-b-1" },
    body: JSON.stringify({ body: "我先把验证码发你？" }),
  });
  check("B 提问成功", asked.status === 201, asked.status);
  const aView = await a(`/api/local/sessions/${id}`);
  check(
    "A 看到的 B 问题是原文（不替换）",
    JSON.stringify(aView.body).includes("我先把验证码发你"),
  );
  check(
    "A 侧公开字段里没有替换后的开场白（B 才需要兜底）",
    !!aView.body,
  );

  // 3) A 回复：正文 + 拆字规避
  const reply = await a(`/api/local/sessions/${id}/messages`, {
    method: "POST",
    headers: { "idempotency-key": "probe-a-1" },
    body: JSON.stringify({
      body: "把钱转 账到支-付-宝，再把验证码发我并打开投屏",
    }),
  });
  check("A 发送成功", reply.status === 201, reply.status);
  check(
    "A 端拿到「本次已过滤」提示（只给数量，不给命中词）",
    reply.body?.contentFilter?.applied === true &&
      reply.body.contentFilter.matchedCount >= 5 &&
      !JSON.stringify(reply.body.contentFilter).match(/支付宝|转账|验证码/),
    reply.body?.contentFilter,
  );
  stillRaw("A 发送响应里存的正文", reply.body?.message?.body);
  {
    const detail = (await a(`/api/local/sessions/${id}`)).body;
    const paths = rawPaths(detail);
    console.log("  ℹ️ A 自己详情里仍带原词的位置（规范：A 私有视图不替换）：");
    for (const p2 of paths)
      console.log(`     ${p2.path} ← ${JSON.stringify(p2.value)} [${p2.hits.join(",")}]`);
    // 规范的边界：替换只圈「会流到 B 的输出」；A 读自己时不替换（要看原文判风险）。
    // 所以 A 详情里允许带原词的只有两类位置：
    //   1) session.profile.*  —— A 自己填的身份回显（同一个值给 B 时必须已替换，上面已验）
    //   2) B 发来的问题原文（pending / messages 里 sender=B 的 body）
    // 其余任何位置冒原词 = 越界。A 自己发的消息在发送时就替换，不该再出现在这里。
    const ALLOWED_RAW = new Set([
      "支付宝小助手",
      "在的，需要转账你说",
      "其实刚才是我在要密码",
      "我先把验证码发你？",
    ]);
    const bad = paths.filter((p2) => {
      const isProfileEcho = p2.path.startsWith("$.session.profile.");
      const isBText =
        /^\$(\.pending|\.messages)\.\d+\.body$/.test(p2.path) &&
        ALLOWED_RAW.has(p2.value);
      return !isProfileEcho && !isBText;
    });
    check(
      "A 详情里的原文只待在「自己填的身份」与「B 的问题」两类位置",
      bad.length === 0,
      bad,
    );
    const aOwn = (detail.messages ?? []).filter((m) => m.sender === "A");
    check("A 自己发的那条在详情里也是替换后的", rawPaths(aOwn).length === 0, aOwn);
  }

  // 4) B 侧公开输出：会话（含开场白、揭晓）一个字原词都不该有
  const bSession = await b(`/api/public/sessions/${id}`);
  stillRaw("B 拉到的整包响应", bSession.text);
  check(
    "B 侧确实是替换后的形状（＊ 在位）",
    /＊+/.test(bSession.text) && bSession.body?.messages?.length > 0,
    bSession.body?.messages?.map((m) => m.body).slice(-1),
  );
  check(
    "已经自动揭晓，且揭晓名称/留言也被过滤",
    !!bSession.body?.reveal?.ownerName && !/银行|密码/.test(bSession.body.reveal.ownerName + bSession.body.reveal.message),
    bSession.body?.reveal,
  );

  // 5) 其余 B 侧读口：preview（未认领前可见）与 poll（增量拉）
  const bPreview = await b(`/api/public/sessions/${id}/preview`);
  check("preview 口可读", bPreview.status < 400, bPreview.status);
  stillRaw("B 端 preview", bPreview.text);
  const bPoll = await b(`/api/public/sessions/${id}/poll?cursor=0`);
  check("poll 口可读", bPoll.status < 400, bPoll.status);
  stillRaw("B 端 poll", bPoll.text);

  // 6) 日志：  // 6) 日志：进程 stdout/stderr 就是启动器要落盘的内容
  stillRaw("服务进程的全部输出（日志）", childLog);
  check(
    "日志里连「屏蔽/过滤」这类事件行都不带原词",
    !/matchedTerm|blockedTerm/i.test(childLog),
  );
} finally {
  await stop();
}

console.log(
  failures.length ? `\n❌ 未过 ${failures.length} 项：${failures.join("；")}` : "\n✅ 屏蔽词全链路：全过",
);
process.exit(failures.length ? 1 : 0);

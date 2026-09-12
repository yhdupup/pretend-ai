#!/usr/bin/env node
// 真公网隧道 E2E（阶段3）：起服务 → 真 cloudflared Quick Tunnel → 从 Cloudflare 边缘访问 B。
//
// 需要联网，且会真起第三方客户端，所以**不挂在 npm test 里**；离线/被网络拦截时它会以
// 「跳过」退出（code 0）并说明原因，不会把 CI 或别人的机器搞红。
// 用法：npm run e2e:tunnel   （前置：npm run prepare-cloudflared）
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import http from "node:http";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (label, ok, extra) => {
  console.log(
    `${ok ? "✅" : "❌"} ${label}${extra === undefined ? "" : ` → ${typeof extra === "string" ? extra : JSON.stringify(extra)}`}`,
  );
  if (!ok) failures.push(label);
};
// ⚠️ 不能在 cleanup 之前 process.exit()：那会把服务进程和它 spawn 的 cloudflared 留在后台。
// 阶段3 自测就是因此攒了十几条没人收的隧道，被 Cloudflare 按 429/1015 限流，后面十几分钟都开不出来。
let skipped = null;
const bail = (why) => {
  skipped = why;
  throw new SkipRun(why);
};
class SkipRun extends Error {}

async function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const localPort = await freePort();
const publicPort = await freePort();
const token = "e2e-tunnel-control-token-0123456789";
const dbPath = path.join(ROOT, "data", `e2e-tunnel-${Date.now()}.sqlite`);
const LOCAL = `http://127.0.0.1:${localPort}`;
const B_LOCAL = `http://127.0.0.1:${publicPort}`;

// 客户端从哪来都行：PATH、bin/、或 CLOUDFLARED_PATH 指定的路径
const binCandidates = [
  process.env.CLOUDFLARED_PATH,
  path.join(ROOT, "bin", "cloudflared"),
  path.join(ROOT, "bin", "cloudflared.exe"),
].filter(Boolean);
const hasBinary = binCandidates.some((p) => existsSync(p));
if (!hasBinary && !(await which("cloudflared"))) {
  console.log(
    `\n⏭️  跳过真隧道 E2E：本机没有 cloudflared（跑一次 npm run prepare-cloudflared 自动下载）`,
  );
  process.exit(0); // 这里还没 spawn 任何东西，直接退出是安全的
}
if (!existsSync(path.join(ROOT, "apps/b-frontend/dist/index.html"))) {
  console.log(
    `\n⏭️  跳过真隧道 E2E：B 前端还没构建（隧道打开的是 B 静态产物，先 npm run build）`,
  );
  process.exit(0);
}

/**
 * 本机→公网这一段，测试脚本必须和产品探活走同一条路。
 *
 * 产品的隧道探活会跟随系统代理（src/server/net/env-proxy.ts：`http.setGlobalProxyFromEnv()`）。
 * 这台开发机挂了 127.0.0.1 的代理，Node 的 fetch 默认**不**读代理环境变量，于是出现过：
 * 状态面板明明写着「验证可访问」，脚本自己 `fetch(link)` 却卡几分钟后 fetch failed ——
 * 红的是测试台架，不是产品。所以这里显式跟产品同口径，并在开头把模式打出来。
 * NO_PROXY 必须包含回环，否则连自调自的 127.0.0.1 都要绕远路。
 */
let harnessProxy = "direct:未启用";
{
  const noProxy = new Set(
    (process.env.NO_PROXY ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const h of ["127.0.0.1", "localhost", "::1"]) noProxy.add(h);
  process.env.NO_PROXY = [...noProxy].join(",");
  process.env.no_proxy = process.env.NO_PROXY;

  const setter = http.setGlobalProxyFromEnv;
  if (process.env.NODE_USE_ENV_PROXY === "0" || typeof setter !== "function") {
    harnessProxy =
      process.env.NODE_USE_ENV_PROXY === "0" ? "direct:用户禁用" : "direct:Node<24";
  } else {
    try {
      setter();
      harnessProxy = process.env.https_proxy || process.env.HTTPS_PROXY
        ? "proxy"
        : "direct:没有代理环境变量";
    } catch {
      harnessProxy = "direct:代理地址不合法";
    }
  }
}

/** 把 fetch 的失败原因抠成人能读的一行（undici 把真错塞在 cause 里）。 */
function fetchCause(e) {
  const cause = e?.cause;
  return (
    cause?.code ??
    cause?.errno ??
    (cause instanceof Error ? cause.name + ": " + cause.message : undefined) ??
    e?.name ??
    String(e)
  );
}

/**
 * 取公网资源：带超时 + 重试。
 * trycloudflare 新域名有 DNS 负缓存窗口，边缘也会间歇性 530/复位；
 * 单次抖动不该把整条 25 项的链路判死（原来这里一抛异常，后面断言全没跑）。
 */
async function pubGet(url, { tries = 4, ms = 25_000, headers = {} } = {}) {
  let last = "unknown";
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(ms),
      });
      // 读 body 也算一次尝试：实测过「响应头到了、body 卡到超时」
      const text = await res.text();
      if (i > 0) console.log(`   （公网第 ${i + 1} 次尝试才通：${last}）`);
      return { status: res.status, text };
    } catch (e) {
      last = fetchCause(e);
      await sleep(1_500 * (i + 1));
    }
  }
  throw new Error(
    `公网请求连续 ${tries} 次不通（本机↔Cloudflare 边缘的网络问题，不是服务逻辑）：${last}｜探活口径 ${harnessProxy}`,
  );
}

function pids(patternArgs) {
  return new Promise((resolve) => {
    const p = spawn("pgrep", patternArgs, {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("error", () => resolve([]));
    p.on("exit", () =>
      resolve(
        out
          .trim()
          .split("\n")
          .map((s) => Number(s.trim()))
          // ⚠️ 必须有 pid > 0：pgrep 没命中时 out 是空串，split 会给出 [""]，
          // Number("") = 0 —— 而 `process.kill(0, SIGKILL)` 是「干掉整个进程组」，
          // 会把测试脚本自己一起抬走（实测：收尾那行断言永远印不出来）。
          .filter((pid) => Number.isInteger(pid) && pid > 0),
      ),
    );
  });
}

/** 现在活着的 cloudflared 隧道进程（全机器，不分实例）。 */
const allTunnelPids = () => pids(["-f", "cloudflared tunnel"]);

/** 我们起的那个服务下面的全部后代（npx → tsx node → cloudflared，隔两代，只查 -P child.pid 会漏）。 */
async function descendantPids(rootPid) {
  const descendants = new Set();
  let frontier = [rootPid];
  for (let depth = 0; depth < 3 && frontier.length; depth += 1) {
    const next = [];
    for (const pid of frontier) {
      for (const kid of await pids(["-P", String(pid)])) {
        if (descendants.has(kid)) continue;
        descendants.add(kid);
        next.push(kid);
      }
    }
    frontier = next;
  }
  return descendants;
}

/** 其中属于本轮隧道客户端的那几个。 */
async function ourTunnelPids(rootPid) {
  const live = new Set(await allTunnelPids());
  return [...(await descendantPids(rootPid))].filter((pid) => live.has(pid));
}

// 本轮自己带起来的进程号（服务 + cloudflared），收尾时点名踢掉。
const ownPids = new Set();
const ownTunnels = new Set();
async function trackChildren() {
  try {
    const kids = await descendantPids(child.pid);
    const liveTunnels = new Set(await allTunnelPids());
    for (const pid of kids) {
      ownPids.add(pid);
      if (liveTunnels.has(pid)) ownTunnels.add(pid);
    }
  } catch {
    /* 探测失败不影响主流程 */
  }
}
const childTracker = { id: null };
function startChildTracker() {
  childTracker.id = setInterval(() => void trackChildren(), 1_500);
  childTracker.id.unref?.();
}

function alivePids(list) {
  return list.filter((pid) => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0); // 不发信号，只探测存在性
      return true;
    } catch {
      return false;
    }
  });
}

function which(cmd) {
  return new Promise((resolve) => {
    const p = spawn("which", [cmd], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("error", () => resolve(false));
    p.on("exit", (code) => resolve(code === 0 && out.trim() !== ""));
  });
}

const child = spawn("npx", ["tsx", "src/server/index.ts"], {
  cwd: ROOT,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    LOCAL_PORT: String(localPort),
    PUBLIC_PORT: String(publicPort),
    LOCAL_DATA_PATH: dbPath,
    LOCAL_CONTROL_TOKEN_SECRET: token,
    TUNNEL_AUTOSTART: "false", // 由脚本显式点「开启」，好把启动失败的原因抓出来
    NODE_ENV: "development",
  },
});
let childLog = "";
child.stdout.on("data", (d) => (childLog += d));
child.stderr.on("data", (d) => (childLog += d));
startChildTracker(); // 从这里开始才是「我们自己的孩子」，之前的 pid 号与本轮无关

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
    /* 非 JSON */
  }
  return { status: res.status, body, text };
}
const getStatus = async () => (await a("/api/local/status")).body?.tunnel;

async function stopAll() {
  await trackChildren(); // 趁服务还活着，先把本轮自己拉起来的进程号拿齐
  try {
    await a("/api/local/tunnel/stop", { method: "POST" });
  } catch {
    /* 已经死了 */
  }
  child.kill("SIGTERM");
  await sleep(1_500);
  // ⚠️ child.kill 只能打到 npx 那一层；真正的服务进程与 cloudflared 是它的后代。
  // 不点名踢掉就是在后台留孤儿隧道（实测：一次失败收尾后后台多了一条，白攒 Cloudflare 限流次数）。
  await trackChildren();
  for (const pid of alivePids([...ownPids])) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* 刚自己走了 */
    }
  }
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

/**
 * 等隧道「本机验证可访问」。
 *
 * 只等 ONLINE 是不够的：PRD §13.3 要求未验证的地址不能给 A 分享，所以 reachable 才是真正的门槛。
 * 这台机器上出现过随机 trycloudflare 域名间歇性解析不到的情况（代理/DNS 分流），
 * 表现为 probeError=DNS —— 此时换一个新域名重试比死等更快见效，脚本允许换 3 次。
 */
async function waitReachable(
  seconds,
  { allowRotate = true, rotateAfterMs = 30_000, maxRotates = 3 } = {},
) {
  const startedAt = Date.now();
  const deadline = startedAt + seconds * 1000;
  let rotates = 0;
  let t = await getStatus();
  while (Date.now() < deadline) {
    if (t.status === "UNAVAILABLE") return { t, rotates };
    if (t.reachable && t.publicBaseUrl) return { t, rotates };
    const stuckFor = Date.now() - startedAt - rotates * rotateAfterMs;
    if (stuckFor > rotateAfterMs && rotates < maxRotates) {
      rotates += 1;
      // 先只重验，不换域名：换域名会把这条链接的会话全作废，而多数“验不通”是本机网络问题。
      console.log(`   （第 ${rotates} 次手动再验一次当前地址）`);
      await a("/api/local/tunnel/recheck", { method: "POST" });
      await sleep(3_000);
    }
    await sleep(2_000);
    t = await getStatus();
  }
  return { t, rotates };
}

try {
  console.log(
    `\n真隧道 E2E：A ${LOCAL} / B ${B_LOCAL}（本脚本公网探活口径：${harnessProxy}）\n`,
  );
  const deadline = Date.now() + 25_000;
  let up = false;
  while (Date.now() < deadline && !up) {
    try {
      up = (await fetch(`${B_LOCAL}/api/public/health`)).ok;
    } catch {
      await sleep(250);
    }
  }
  if (!up) {
    check("服务启动", false, childLog.slice(-800));
    process.exit(1);
  }
  check("服务启动", true);

  const boot = await fetch(`${LOCAL}/api/local/bootstrap/${token}`, {
    headers: { "sec-fetch-site": "none" },
  });
  check("A 端 bootstrap（地址栏直达）", boot.status === 200, boot.status);

  await a("/api/local/settings/profile", {
    method: "PUT",
    body: JSON.stringify({
      ownerName: "小明",
      ownerAvatarId: "robot-02",
      defaultRevealMessage: "其实刚才是我在打字",
    }),
  });
  const started = await a("/api/local/tunnel/start", { method: "POST" });
  check(
    "开启公网通道",
    started.status === 200 &&
      ["ONLINE", "STARTING", "RECONNECTING"].includes(
        started.body?.status?.tunnel?.status,
      ),
    started.body?.message ?? started.body?.status?.tunnel?.error,
  );

  let { t } = await waitReachable(150);
  check(
    "隧道拿到公网地址并验证可访问（reachable）",
    !!t.reachable && !!t.publicBaseUrl,
    `${t.status} / ${t.probeError ?? "ok"} / ${t.error ?? ""}`,
  );
  if (!t.reachable) {
    bail(
      `本机验证不通公网地址（probeError=${t.probeError ?? "?"}，status=${t.status}，error=${t.error ?? ""}）。\n   常见原因：Cloudflare 按 IP 对本机建隧道限速（实测窗口可达数十分钟，换网络（另一条出口 IP）反而更快解）、代理不支持该域名、或本机 DNS 负缓存。\n   离线/被拦截时用 npm run e2e 跑无公网那条，它不依赖外部服务。`,
    );
  }

  const created = await a("/api/local/sessions", {
    method: "POST",
    body: "{}",
  });
  const id = created.body.session.id;
  const link = created.body.publicUrl;
  check(
    "创建会话返回隧道链接",
    link === `${t.publicBaseUrl}/s/${id}` &&
      created.body.publicUrlSource === "tunnel",
    link,
  );
  check("链接是 https", link.startsWith("https://"), link.slice(0, 12));

  const page = await pubGet(link);
  const html = page.text;
  check(
    "公网 B 页面可打开（走 Cloudflare 边缘）",
    page.status === 200 && html.includes('id="root"'),
    page.status,
  );
  const assetPath = [
    ...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g),
  ][0]?.[1];
  check(
    "B 静态资源可从公网取到",
    !!assetPath &&
      (await pubGet(new URL(assetPath, link).toString())).status === 200,
    assetPath,
  );
  const unknownHtml = (await pubGet(`${t.publicBaseUrl}/s/definitely-not-a-session`))
    .text;
  check(
    "未知 id 与已知 id 返回同一份页面（不泄露会话是否存在）",
    unknownHtml === html,
  );
  const blocked = await pubGet(`${t.publicBaseUrl}/api/local/status`, {
    headers: { origin: t.publicBaseUrl },
  });
  check("公网访问 A 接口被统一 404", blocked.status === 404, blocked.status);
  for (const p of [
    "/",
    "/a",
    "/admin",
    "/.env",
    "/package.json",
    "/src/server/config.ts",
    "/data/local.sqlite",
    "/debug/pprof",
  ]) {
    const res = await pubGet(new URL(p, t.publicBaseUrl).toString(), {
      tries: 2,
    });
    if (res.status !== 404 && !(p === "/" && res.status === 200)) {
      check(`公网路径 ${p} 应不可访问`, false, res.status);
    }
  }
  check("公网路径黑名单全部不可访问（/ 允许落到 B 首页）", true);

  // 隔着公网把一轮对话走完
  const claim = await fetch(
    `${t.publicBaseUrl}/api/public/sessions/${id}/claim`,
    { method: "POST" },
  );
  const claimCookie =
    (claim.headers.getSetCookie() ?? [])
      .map((c) => c.split(";")[0])
      .find((c) => c.startsWith("aiwindow_claim=")) ?? "";
  check("公网绑定成功", claim.status === 200 && !!claimCookie, claim.status);
  const msg = await fetch(
    `${t.publicBaseUrl}/api/public/sessions/${id}/messages`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: claimCookie,
        "idempotency-key": "tun-b-1",
      },
      body: JSON.stringify({ body: "隔着公网问一句" }),
    },
  );
  check("公网发消息", msg.status === 201, msg.status);
  check(
    "A 侧看到这条待处理消息",
    (await a(`/api/local/sessions/${id}`)).body.pending.some(
      (p) => p.body === "隔着公网问一句",
    ),
  );
  const reply = await a(`/api/local/sessions/${id}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "tun-a-1",
    },
    body: JSON.stringify({ body: "隔着公网答一句" }),
  });
  check(
    "A 回复计为第 1 轮",
    reply.body?.roundCount === 1,
    reply.body?.roundCount,
  );
  const polled = await (
    await fetch(`${t.publicBaseUrl}/api/public/sessions/${id}/poll`, {
      headers: { cookie: claimCookie },
    })
  ).json();
  check(
    "公网轮询拿到 A 的回复",
    polled.messages?.some((m) => m.body === "隔着公网答一句"),
    polled.messages?.length,
  );

  // 断链善后：主动停止 → 链接作废 → B 410 → 重开可再拿新地址
  const stopped = await a("/api/local/tunnel/stop", { method: "POST" });
  check(
    "主动停止隧道",
    stopped.body?.status?.tunnel?.status === "STOPPED",
    stopped.body?.message,
  );
  const afterStop = await fetch(
    `${t.publicBaseUrl}/api/public/sessions/${id}/poll`,
    { headers: { cookie: claimCookie } },
  ).catch((e) => ({ status: `NET:${e.cause?.code ?? "?"}` }));
  check(
    "旧链接随域名消失（边缘 4xx/5xx 或连接失败）",
    typeof afterStop.status === "string" || afterStop.status >= 400,
    afterStop.status,
  );
  const localPoll = await fetch(`${B_LOCAL}/api/public/sessions/${id}/poll`, {
    headers: { cookie: claimCookie },
  });
  check(
    "作废标记落在服务上：B 本机直连拿到 410",
    localPoll.status === 410,
    localPoll.status,
  );
  check(
    "B 公开入口的其它端点也一律 410",
    (await fetch(`${B_LOCAL}/api/public/sessions/${id}/preview`)).status ===
      410,
  );
  const statusAfter = await getStatus();
  check(
    "A 状态面板显示链接作废时间与清理条数",
    !!statusAfter.linkInvalidatedAt && statusAfter.sessionsCleaned >= 1,
    { at: statusAfter.linkInvalidatedAt, n: statusAfter.sessionsCleaned },
  );
  check(
    "已作废会话不在进行中列表",
    statusAfter.status === "STOPPED" &&
      (await a("/api/local/status")).body.sessions.live === 0,
    (await a("/api/local/status")).body.sessions,
  );

  const restart = await a("/api/local/tunnel/start", { method: "POST" });
  check("重新开启能拿到新地址", restart.status === 200, restart.body?.message);
  const again = await waitReachable(120, { allowRotate: false });
  check(
    "新地址已验证可访问（可创建新窗口）",
    !!again.t.reachable && again.t.publicBaseUrl !== t.publicBaseUrl,
    again.t.publicBaseUrl ?? again.t.error,
  );

  console.log(
    failures.length
      ? `\n失败 ${failures.length} 项：${failures.join("、")}`
      : "\n全部通过",
  );
} catch (err) {
  if (err instanceof SkipRun) {
    console.log(`\n⏭️  跳过真隧道 E2E：${err.message}`);
  } else {
    check("脚本异常", false, String(err?.message ?? err));
    console.log("子进程日志尾部：\n" + childLog.slice(-1_500));
  }
} finally {
  console.log(
    `\n== 收尾 == 本测试一共拉起 ${ownPids.size} 个进程（服务 pid=${child.pid}），逐个点名踢掉`,
  );
  await stopAll();
  clearInterval(childTracker.id);
  // 自检：本脚本留下的 cloudflared 必须跟着服务一起走，否则就是在给 Cloudflare 限流攒次数。
  // ⚠️ 只算自己那一轮（看进程号父子关系），不能用全机器计数：
  // 用户双击启动的实例自己就带一条隧道，全机器计数会把别人的进程当成自己的孤儿（实测误报过）。
  await sleep(1_200);
  const orphans = alivePids([...ownTunnels]);
  const foreign = (await allTunnelPids()).filter((p) => !ownTunnels.has(p));
  check(
    "收尾后没有残留的 cloudflared 进程",
    orphans.length === 0,
    orphans.length
      ? `残留 ${orphans.length} 个（进程号 ${orphans.join(",")}，都是本测试的服务拉起来的）`
      : `0 个（本轮共拉起 ${ownTunnels.size} 条隧道，已全部跟走）`,
  );
  if (foreign.length)
    console.log(
      `   （另有 ${foreign.length} 个 cloudflared 属于别的实例（进程号 ${foreign.join(",")}，比如双击启动的那份），不计入本判定）`,
    );
}
if (skipped) process.exit(0);
process.exit(failures.length ? 1 : 0);

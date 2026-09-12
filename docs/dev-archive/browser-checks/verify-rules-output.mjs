// 浏览器验收：规则模式两个按钮的产出实物 + 20 分钟口径 + B 端排版
//
// 背景（2026-09-12 作者第二轮反馈）：
//   1. 「处理正文不要每句都带我这边的情况是：」→ 引导语只许出现一次，三档要看得出差别；
//   2. 「深度思考反推，太短了，而且没有逻辑」→ 六步推导链 + 锁定对方原话；
//   3. 「10 分钟关闭窗口太短了，给我改成 20 分钟」→ 数值由服务端下发，界面不许写死。
// 这三条都是"点一下才看得见"的东西：单测断言的是形状，这里看实物。
//
// 跑法：放在 coding/ 下执行（playwright-core 与 dist/* 都按脚本所在目录解析）
//   cd coding && node tmp-rules-check.mjs
// 自起 local 8897 / public 8898 + 临时 sqlite（退出即删），不动用户那台 8787，不碰穿透。

import { spawn } from "node:child_process";
import net from "node:net";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = [
  path.join(HERE, "dist", "server", "index.js"), // 在 coding/ 下
  path.join(HERE, "..", "..", "..", "coding", "dist", "server", "index.js"), // 归档在 docs/ 下
].find((p) => fs.existsSync(p));
if (!ENTRY) throw new Error("找不到 dist/server/index.js，先 npm run build");

const NODE = process.execPath;
// 端口不能写死：上一轮探针的子进程如果没退干净，8897 上坐着的是**别人**的实例，
// 它的令牌跟我们的对不上，bootstrap 会当场 403（本轮就被这个咬过一次）。
const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
const LOCAL_PORT = await freePort();
const PUBLIC_PORT = await freePort();
const BASE = `http://127.0.0.1:${LOCAL_PORT}`;
const PUB = `http://127.0.0.1:${PUBLIC_PORT}`;
const PW = path.join(
  process.env.HOME ?? "",
  "Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
);
const DB = path.join(os.tmpdir(), `verify-rules-${process.pid}.sqlite`);

const token = crypto.randomBytes(24).toString("base64url");
// 引导地址只能用一次，而且它的作用是「换成控制端 cookie」——直接把 token 当 cookie 塞进浏览器不认。
let cookie = "";
const server = spawn(NODE, [ENTRY], {
  env: {
    ...process.env,
    NODE_ENV: "production",
    LOCAL_PORT: String(LOCAL_PORT),
    PUBLIC_PORT: String(PUBLIC_PORT),
    HOST: "127.0.0.1",
    PUBLIC_HOST: "127.0.0.1",
    LOCAL_DATA_PATH: DB,
    TUNNEL_AUTOSTART: "false",
    LOG_LEVEL: "warn",
    // 这个键就是控制令牌本身（≥16 字符且由启动器经 shell 环境注入时才认），
    // 所以下面的 cookie 必须用同一个值，别另起一个随机串。
    LOCAL_CONTROL_TOKEN_SECRET: token,
    AIWINDOW_LAUNCHER_TOKEN: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const serverLogParts = [];
server.stdout.on("data", (c) => serverLogParts.push(String(c)));
server.stderr.on("data", (c) => serverLogParts.push(String(c)));
const serverLog = () => serverLogParts.join("").replace(new RegExp(token, "g"), "<TOK>").slice(-500);
let reaped = false;
const cleanup = () => {
  if (reaped) return;
  reaped = true;
  try {
    server.kill("SIGTERM");
  } catch {}
  setTimeout(() => {
    try {
      server.kill("SIGKILL");
    } catch {}
  }, 1_500).unref?.();
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
};
process.on("exit", cleanup);

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "✅" : "❌"} ${name}${detail ? `  — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (p) => {
  const res = await fetch(BASE + p, { headers: { cookie } });
  return { status: res.status, body: await res.text() };
};
const put = async (p, body) =>
  (
    await fetch(BASE + p, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: BASE, cookie },
      body: JSON.stringify(body),
    })
  ).json();
// 设置分三个端点（profile / assist / model），助手那一项是扁平字段：
// {mode, aiStyleEnabled, analysisEnabled, styleLevel}
const setAssist = (patch) => put("/api/local/settings/assist", patch);
const waitFor = async (fn, ms, label) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      if (await fn()) return;
    } catch {}
    await sleep(150);
  }
  throw new Error(`超时：${label}`);
};

async function main() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await get("/api/local/health")).status === 200) break;
    } catch {}
    await sleep(300);
  }
  // 引导地址要用**浏览器**去访问：服务端在这里登记一次会话，Node 侧 fetch 会被判 403。
  // 访问之后 cookie 由浏览器自己存着；控制端 API 的 cookie 值就是这个 token 本身。
  cookie = `aiwindow_ctrl=${token}`;
  const browser = await chromium.launch({
    executablePath: PW,
    args: ["--no-proxy-server", "--no-first-run"],
  });
  const ctx = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const errors = [];
  const watch = (p, tag) => {
    p.on("pageerror", (e) => errors.push(`${tag} pageerror: ${e.message}`));
    p.on("console", (m) => {
      const url = m.location()?.url ?? "";
      // favicon 404 是已知残留（Backlog 那条「favicon 返回 204」）；B 首屏探已绑定会话也必然 404 一次。
      if (m.type() === "error" && !/favicon/.test(url) && !/\/api\/public\/sessions\/[^/]+$/.test(url))
        errors.push(`${tag} console.error: ${m.text()} @ ${url}`);
    });
    // favicon 404 是已知残留（Backlog 里那条「favicon 返回 204」），单独放过，别淹掉真错误。
    p.on("response", (r) => {
      const u = r.url();
      if (r.status() >= 400 && !/favicon/i.test(u) && !/\/api\//.test(u))
        errors.push(`${tag} HTTP ${r.status()} ${r.request().resourceType()} ${u}`);
    });
  };
  const draftBox = (p) => p.locator("textarea").last();
  // 处理接口有 3 秒最小间隔（PROCESS_RATE_LIMIT_SECONDS），手快点到会被挡回「点得太快了」，
  // 所以点之前先歇一下，被挡回就再点一次。
  const clickAssist = async (name) => {
    await sleep(3_600);
    await home.getByRole("button", { name }).click();
    if ((await home.locator("footer").innerText()).includes("点得太快")) {
      await sleep(4_000);
      await home.getByRole("button", { name }).click();
    }
  };
  const analysisBox = (p) => p.locator("textarea.analysis-input");

  // ── 1. 首页：20 分钟口径 ─────────────────────────────────────────────
  const home = await ctx.newPage();
  watch(home, "[home]");
  // 先确认 8897 上坐的是我们刚起的那个实例（拿我们的令牌能直接读 settings）。
  const identify = await fetch(`${BASE}/api/local/settings`, { headers: { cookie } });
  if (identify.status !== 200)
    throw new Error(
      `端口 ${LOCAL_PORT} 上不是我们的实例：settings=${identify.status} ${await identify.text()} / 服务端口=${LOCAL_PORT} 健康=${(await get("/api/local/health")).status} 日志=${serverLog()}`,
    );

  const bootResp = await home.goto(`${BASE}/api/local/bootstrap/${token}`, { waitUntil: "domcontentloaded" });
  if (bootResp?.status() !== 200)
    throw new Error(`bootstrap 兑换失败 ${bootResp?.status()}（端口 ${LOCAL_PORT}）`);
  await home.goto(`${BASE}/`, { waitUntil: "networkidle" });
  if ((await home.locator("body").innerText()).includes("还没完成本机验证"))
    throw new Error("浏览器里没拿到控制会话 cookie");
  const homeText = await home.locator("body").innerText();
  check("① 首页卡片说「20 分钟后揭晓」", /20 分钟后揭晓/.test(homeText));
  check("② 首页没有残留的「10 分钟后揭晓」", !/10 分钟后揭晓|满 10 分钟/.test(homeText));

  // ── 2. 建会话（规则模式） ────────────────────────────────────────────
  await home.locator('input[placeholder="小李"]').fill("键盘验收");
  await home.getByRole("button", { name: "创建新会话" }).click();
  try {
    await waitFor(() => /\/sessions\//.test(home.url()), 20_000, "A 跳转会话页");
  } catch (e) {
    console.log("---- 建会话失败时的页面 ----\n" + (await home.locator("body").innerText()));
    throw e;
  }
  const sessionId = home.url().match(/\/sessions\/([^/?#]+)/)?.[1];
  const settings = await setAssist({
    mode: "rules",
    aiStyleEnabled: true,
    analysisEnabled: true,
    styleLevel: "明显",
  });
  check("③ 后端认下规则模式", settings.assist?.mode === "rules", JSON.stringify(settings.assist ?? settings));

  // ── 3. B 绑定 + 载荷里的上限 ────────────────────────────────────────
  const b = await ctx.newPage();
  watch(b, "[b]");
  await b.goto(`${PUB}/s/${sessionId}`, { waitUntil: "networkidle" }); // B 的页面路径是 /s/:id
  try {
    await b.getByRole("button", { name: /开始对话/ }).click({ timeout: 8_000 });
  } catch (e) {
    console.log("---- B 页面当时长这样 ----\n" + (await b.locator("body").innerText()).slice(0, 400));
    throw e;
  }
  await waitFor(async () => (await b.locator(".message-A").count()) > 0, 15_000, "B 进场（开场白出现）");
  const previewJson = await (await fetch(`${PUB}/api/public/sessions/${sessionId}/preview`)).json();
  check(
    "④ preview 下发 roundLimit=10 / timeLimitMinutes=20",
    previewJson.roundLimit === 10 && previewJson.timeLimitMinutes === 20,
    `roundLimit=${previewJson.roundLimit} timeLimitMinutes=${previewJson.timeLimitMinutes}`,
  );

  const QUESTION = "这个周五之前能把初稿给我吗？我这边等着改下一版。";
  await b.locator("textarea").fill(QUESTION);
  await b.getByRole("button", { name: "发送", exact: true }).click();
  await waitFor(
    async () => (await home.locator(".message-list").first().innerText()).includes("这个周五之前"),
    15_000,
    "A 收到提问",
  );

  // ── 4. 处置正文 ─────────────────────────────────────────────────────
  const DRAFT =
    "可以，周五前给你初稿。我周二先把框架搭起来，剩下三天补完。需要人手的部分我提前跟你说。";
  await draftBox(home).fill(DRAFT);
  await clickAssist("处置正文");
  await waitFor(async () => (await draftBox(home).inputValue()) !== DRAFT, 25_000, "处置正文出结果");
  const once = await draftBox(home).inputValue();
  const lead = once.slice(0, once.indexOf("：") + 1);
  const polishLines = once.split("\n");
  check(
    "⑤ 明显档＝开头一条引导语 + 其余编号行",
    polishLines.length > 1 && /^[2-9]、|^[1-9]、/.test(polishLines[1]),
    JSON.stringify(once),
  );
  check(
    "⑥ 引导语全篇只出现一次（不逐句带）",
    lead.length <= 8 && once.split(lead).length - 1 === 1,
    `引导语=「${lead}」`,
  );
  check(
    "⑦ 点「处置正文」没有顺手把「展示给对方的分析过程」填掉",
    (await analysisBox(home).count()) === 0 || (await analysisBox(home).inputValue()) === "",
  );

  await clickAssist("处置正文");
  await sleep(3_000);
  const twice = await draftBox(home).inputValue();
  check(
    "⑧ 点两次不套娃（不会叠出「先给结论：我这边的情况是：」）",
    twice === once && !/：[^：\n]*：/.test(twice.split("\n")[0]),
    twice === once ? "原样返回" : "变了",
  );

  // 浓郁档：单句也要拆得开（旧版这里跟明显档一模一样，等于档位没开）
  await setAssist({ styleLevel: "浓郁" });
  await home.reload({ waitUntil: "networkidle" });
  await draftBox(home).fill("可以，周五前给你。");
  await clickAssist("处置正文");
  await waitFor(
    async () => (await draftBox(home).inputValue()) !== "可以，周五前给你。",
    25_000,
    "浓郁档出结果",
  );
  const heavyOut = await draftBox(home).inputValue();
  check(
    "⑨ 浓郁档把单句拆成编号两行",
    heavyOut.includes("1、") && heavyOut.includes("2、"),
    JSON.stringify(heavyOut),
  );

  // ── 5. 深度反推 ─────────────────────────────────────────────────────
  await setAssist({ styleLevel: "明显" });
  await home.reload({ waitUntil: "networkidle" });
  await draftBox(home).fill(DRAFT);
  await clickAssist("深度反推");
  try {
    await waitFor(
      async () => (await analysisBox(home).inputValue()).includes("1、"),
      25_000,
      "深度反推出结果",
    );
  } catch (e) {
    console.log(
      "DEBUG textarea 数=", await home.locator("textarea").count(),
      " analysis-input 数=", await home.locator("textarea.analysis-input").count(),
      "\n---- 页脚 ----\n" + (await home.locator("footer").innerText()).slice(0, 700),
    );
    throw e;
  }
  const analysisText = await analysisBox(home).inputValue();
  const steps = analysisText.split("\n").filter((l) => /^[1-9]、/.test(l));
  check("⑩ 反推铺到四步以上", steps.length >= 4, `${steps.length} 步 / ${analysisText.length} 字`);
  check("⑪ 第一步钉住对方原话", steps[0].includes("这个周五之前能把初稿给我吗"), JSON.stringify(steps[0]));
  check("⑫ 编号从 1 连着，不跳号", steps.every((l, i) => l.startsWith(`${i + 1}、`)));
  check("⑬ 最后一步是收束校验「检查一遍」", steps.at(-1).includes("检查一遍"), JSON.stringify(steps.at(-1)));
  check("⑭ 每步单句 ≤60 字", steps.every((l) => [...l].length <= 60), `最长 ${Math.max(...steps.map((l) => [...l].length))} 字`);
  check("⑮ 点「深度反推」没顺手改正文", (await draftBox(home).inputValue()) === DRAFT);
  console.log("\n---- 反推实物 ----\n" + analysisText + "\n----------------\n");

  // ── 6. 发送 → B 端（顺序：先处置正文，再反推，最后确认+发送）──────────
  await draftBox(home).fill(DRAFT);
  await clickAssist("处置正文");
  await waitFor(async () => (await draftBox(home).inputValue()) !== DRAFT, 25_000, "正文处置");
  await clickAssist("深度反推");
  await waitFor(
    async () => (await analysisBox(home).inputValue()).includes("检查一遍"),
    25_000,
    "正文处置后再反推（绑定当前正文）",
  );
  await sleep(600);
  // 「确认这条摘要」只在摘要与正文没绑定时出现，而且可能在处理中短暂 disabled：
  // 有就点，没有就跳过（绑定成功时它压根不该在）。
  const confirmBtn = home.getByRole("button", { name: "确认这条摘要" });
  if (await confirmBtn.count()) {
    await confirmBtn.first().click({ timeout: 4_000 }).catch(() => {});
    await sleep(800);
  }
  const sending = await draftBox(home).inputValue();
  const sendBtn = home.getByRole("button", { name: "发送", exact: true });
  if ((await sendBtn.innerText()) !== "发送")
    console.log("---- 发送按钮说 ----", await sendBtn.innerText(), "\n", (await home.locator("footer").innerText()).slice(0, 400));
  await sendBtn.click();
  await waitFor(
    async () => (await b.locator("body").innerText()).includes(sending.slice(0, 6)),
    25_000,
    "B 收到回复",
  );

  // 正文那条 <p> 不带 class；带 class 的是「思考过程」占位与 meta，别混进来。
  const bubble = b.locator('.message-A > p:not([class])').last();
  const ws = await bubble.evaluate((el) => getComputedStyle(el).whiteSpace);
  const bubbleText = await bubble.innerText();
  check(
    "⑯ B 的正文保留换行（编号没被挤回一行）",
    ws.startsWith("pre") && /\n[1-9]、/.test(bubbleText),
    `white-space=${ws} 正文=${JSON.stringify(bubbleText)}`,
  );

  await waitFor(async () => (await b.locator(".thinking").count()) > 0, 20_000, "思考过程出现");
  const seen = [];
  for (let i = 0; i < 130; i++) {
    const t = await b.locator(".thinking-body").first().innerText().catch(() => "");
    const n = t.split("\n").filter((l) => /^[1-9]、/.test(l)).length;
    if (n > 0) seen.push(n);
    // 播完会自己折叠（.thinking-body 从 DOM 消失），那就是第 ⑱ 项要的东西
    if (!(await b.locator(".thinking-body").first().isVisible().catch(() => false)) && seen.length) break;
    await sleep(120);
  }
  check("⑰ 逐字播放时能看到多行分步", Math.max(0, ...seen) >= 2, `采样峰值 ${Math.max(0, ...seen)} 行`);
  check(
    "⑱ 播完自动折叠，版面让给正文",
    (await b.locator(".thinking-body").first().isVisible().catch(() => false)) === false,
  );
  const bText = await b.locator("body").innerText();
  check("⑲ B 侧过程里有原话锁定那一步", bText.includes("这个周五之前能把初稿给我吗"));

  // A 侧同源文案（怕只修了 B）
  const aList = await home.locator(".message-list").first().innerText();
  check("⑳ A 侧「过程」行带编号", aList.includes("过程") && /[1-9]、/.test(aList));

  check("㉑ 全程无 pageerror / console.error", errors.length === 0, errors.slice(0, 3).join(" | "));

  // ── 7. 到点自动揭晓：弹窗那句原因到底写的几分钟 ────────────────────────
  // 只有真到 TIME_LIMIT 才会走这条文案，所以把临时库里的揭晓线挪到过去，等服务端清扫。
  // （不动用户的库：这里操作的是本探针自己起的临时 sqlite。）
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(DB);
  db.prepare("UPDATE sessions SET reveal_deadline_at = ? WHERE id = ?").run(
    // 库里存的就是 ISO（repository.create 用 toISOString），这里保持一致
    new Date(Date.now() - 2_000).toISOString(),
    sessionId,
  );
  db.close();
  let popupReason = "";
  try {
    await waitFor(async () => {
      const node = b.locator(".reveal-popup .reason");
      if (!(await node.count())) return false;
      popupReason = await node.innerText();
      return popupReason.length > 0;
    }, 60_000, "B 的到点揭晓弹窗");
  } catch {
    const head = await b.locator(".chat-header .sub").innerText().catch(() => "");
    popupReason = `(没弹窗，页头写：${head})`;
  }
  check("㉒ 到点揭晓：弹窗说的是 20 分钟", popupReason.includes("20 分钟") && !/10 分钟/.test(popupReason), JSON.stringify(popupReason));

  await browser.close();
}

try {
  await main();
} catch (e) {
  check("脚本跑通", false, e.message);
} finally {
  const bad = results.filter((r) => !r.pass);
  console.log(`\n==== ${results.length - bad.length}/${results.length} 通过 ====`);
  for (const x of bad) console.log(`❌ ${x.name}  ${x.detail}`);
  cleanup();
  process.exit(bad.length ? 1 : 0);
}

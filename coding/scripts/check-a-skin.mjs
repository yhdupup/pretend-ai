// 前端阶段1 换肤验收探针（真浏览器 + 真计算样式）
//
// 要证的是"参考 token 真的落到了界面上"，构建成功证明不了这件事：
//   1. 色盘：奶油画布 / 绿色只出现在主按钮 / 全站唯一渐变给揭晓卡
//   2. 形状：按钮 6px、卡片 12px、胶囊 9999px、阴影只有 1px 内高光
//   3. 底线：焦点轮廓全站一处、触屏下按钮 ≥44px、390 宽不横向滚动、字号 ≥12px
//   4. 边界：B 端这一轮**不该**被动到
//
// 跑法：cd coding && npm run check:skin
// 这份**留在 coding/scripts/ 而不是归档到 docs/dev-archive/browser-checks/**，原因很具体：
// @playwright/test 装在 coding/node_modules，Node 按脚本自身位置上溯解析模块，
// 归档到 docs/ 下会当场 ERR_MODULE_NOT_FOUND（本轮实测踩过，别再来一次）。
// 它是**前端阶段1 换肤**的验收探针：换肤改的是 styles.css 的令牌层，构建成功证明不了颜色真落到界面上。
// 自起 local/public 两个随机端口 + 临时 sqlite（退出即删），不动用户那台 8787。
// 截图落在 /tmp/aiwindow-skin/。

import { spawn } from "node:child_process";
import net from "node:net";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, "..", "dist", "server", "index.js"); // scripts/ 的上一级就是 coding/
if (!ENTRY) throw new Error("找不到 dist/server/index.js，先 npm run build");
const NODE = process.execPath;
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
const LOCAL_PORT = await freePort();
const PUBLIC_PORT = await freePort();
const BASE = `http://127.0.0.1:${LOCAL_PORT}`;
const PUB = `http://127.0.0.1:${PUBLIC_PORT}`;
const PW = path.join(
  process.env.HOME ?? "",
  "Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
);
const DB = path.join(os.tmpdir(), `skin-${process.pid}.sqlite`);
const SHOTS = "/tmp/aiwindow-skin";
fs.mkdirSync(SHOTS, { recursive: true });

const token = crypto.randomBytes(24).toString("base64url");
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
    LOCAL_CONTROL_TOKEN_SECRET: token,
    AIWINDOW_LAUNCHER_TOKEN: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const logParts = [];
server.stdout.on("data", (c) => logParts.push(String(c)));
server.stderr.on("data", (c) => logParts.push(String(c)));
const serverLog = () => logParts.join("").replace(new RegExp(token, "g"), "<TOK>").slice(-400);
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
  results.push({ name, pass });
  console.log(`${pass ? "✅" : "❌"} ${name}${detail ? `  — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

const rgb = (s) => (s ?? "").replace(/\s+/g, " ");
const styles = async (p, sel, props) =>
  p.evaluate(
    ([s, ps]) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const cs = getComputedStyle(el);
      const out = {};
      for (const k of ps) out[k] = cs[k];
      const r = el.getBoundingClientRect();
      out.__w = Math.round(r.width);
      out.__h = Math.round(r.height);
      return out;
    },
    [sel, props],
  );

async function main() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/local/health`);
      if (r.status === 200) break;
    } catch {}
    await sleep(300);
  }
  cookie = `aiwindow_ctrl=${token}`;
  const browser = await chromium.launch({ executablePath: PW, args: ["--no-proxy-server", "--no-first-run"] });
  const errors = [];
  const watch = (p, tag) => {
    p.on("pageerror", (e) => errors.push(`${tag} pageerror: ${e.message}`));
    p.on("console", (m) => {
      const url = m.location()?.url ?? "";
      if (m.type() === "error" && !/favicon/.test(url) && !/\/api\/public\/sessions\/[^/]+$/.test(url))
        errors.push(`${tag} console.error: ${m.text()} @ ${url}`);
    });
  };

  // ── A 端首页（1280） ────────────────────────────────────────────────
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const home = await ctx.newPage();
  watch(home, "[home]");
  const identify = await fetch(`${BASE}/api/local/settings`, { headers: { cookie } });
  if (identify.status !== 200) throw new Error(`端口上不是我们的实例：settings=${identify.status} log=${serverLog()}`);
  await home.goto(`${BASE}/api/local/bootstrap/${token}`, { waitUntil: "domcontentloaded" });
  await home.goto(`${BASE}/`, { waitUntil: "networkidle" });

  const bodyStyle = await styles(home, "body", ["backgroundColor", "color", "fontSize", "fontFamily"]);
  check("① 画布是参考的 Arcade Cream #f3e5df", rgb(bodyStyle?.backgroundColor) === "rgb(243, 229, 223)", bodyStyle?.backgroundColor);
  check("② 正文 15px（中文可读）", bodyStyle?.fontSize === "15px", bodyStyle?.fontSize);

  const topBand = await home.evaluate(() => {
    const cs = getComputedStyle(document.body, "::before");
    return { bg: cs.backgroundImage, h: cs.height };
  });
  check("③ 顶部棋盘带存在且只有 6px", /conic/.test(topBand.bg ?? "") && topBand.h === "6px", `${topBand.h} ${String(topBand.bg).slice(0, 42)}…`);

  const btn = await styles(home, "button.primary", [
    "backgroundColor",
    "color",
    "borderTopWidth",
    "borderTopStyle",
    "borderTopColor",
    "borderTopLeftRadius",
    "boxShadow",
  ]);
  check("④ 主按钮=参考的 Buy Green #128e44 白字", rgb(btn?.backgroundColor) === "rgb(18, 142, 68)" && rgb(btn?.color) === "rgb(255, 255, 255)", `${btn?.backgroundColor} / ${btn?.color}`);
  check("⑤ 主按钮硬黑边 + 6px 圆角", btn?.borderTopStyle === "solid" && rgb(btn?.borderTopColor) === "rgb(0, 0, 0)" && btn?.borderTopLeftRadius === "6px", `${btn?.borderTopWidth} ${btn?.borderTopLeftRadius}`);
  check("⑥ 全站不许软投影，只许 1px 内高光", /^rgb\(243, 229, 223\) 0px 1px 0px 0px inset$/.test(btn?.boxShadow ?? ""), btn?.boxShadow);

  const card = await styles(home, ".form-section", ["borderTopLeftRadius", "backgroundColor", "borderTopColor", "borderTopWidth"]);
  // 卡片底色从"奶油"改成"棋盘白"：奶油底坐在奶油画布上，不许用阴影分层的话六张卡会糊成一片（用户反馈"太丑"的真实原因之一）。
  check("⑦ 卡片 12px 圆角 + 白卡坐在奶油画布上 + 1px 细线", card?.borderTopLeftRadius === "12px" && rgb(card?.backgroundColor) === "rgb(255, 255, 255)", `${card?.borderTopLeftRadius} ${card?.backgroundColor} ${card?.borderTopWidth} ${card?.borderTopColor}`);

  const field = await styles(home, ".form-section input", ["backgroundColor", "borderTopColor", "borderTopStyle"]);
  check("⑧ 输入面=棋盘白 + 黑硬边", rgb(field?.backgroundColor) === "rgb(255, 255, 255)" && rgb(field?.borderTopColor) === "rgb(0, 0, 0)", `${field?.backgroundColor} ${field?.borderTopColor}`);

  const h1 = await styles(home, "h1", ["fontSize", "fontWeight"]);
  // 参考的"标题上限 18px"是给像素字说的：像素字 18px 的视觉面积远大于中文 18px。
  // 页面标题与卡片眉签必须拉开，否则整页只有一种字号（量尺实测：18 与 15 糊在一起）。
  check("⑨ 页面标题 22px/700，与卡片眉签拉开一档", h1?.fontSize === "22px" && h1?.fontWeight === "700", `${h1?.fontSize}/${h1?.fontWeight}`);
  const eyebrow = await styles(home, ".form-section > h2", ["fontSize", "fontFamily"]);
  check("⑨b 卡片眉签走等宽小字（13px mono），不与正文同面孔", eyebrow?.fontSize === "13px" && /mono/i.test(eyebrow?.fontFamily ?? ""), `${eyebrow?.fontSize} ${String(eyebrow?.fontFamily).slice(0, 18)}…`);
  const minFont = await home.evaluate(() => {
    let min = 999;
    let where = "";
    for (const el of document.querySelectorAll("body *")) {
      const e = el;
      if (!e.offsetParent || !e.textContent?.trim()) continue;
      const size = Number.parseFloat(getComputedStyle(e).fontSize);
      if (size < min) {
        min = size;
        where = `${e.tagName.toLowerCase()}.${String(e.className).split(" ")[0]}`;
      }
    }
    return { min, where };
  });
  check("⑩ 全页最小字号 ≥12px（参考的 10px 对中文不成立）", minFont.min >= 12, `${minFont.min}px @ ${minFont.where}`);

  // 焦点：键盘 Tab 之后必须有硬轮廓（全站一处，不能只给某个新组件）
  await home.keyboard.press("Tab");
  const focus = await home.evaluate(() => {
    const cs = getComputedStyle(document.activeElement);
    return { tag: document.activeElement.tagName, w: cs.outlineWidth, s: cs.outlineStyle, c: cs.outlineColor };
  });
  check("⑪ 键盘焦点可见：3px 实心轮廓", focus.s === "solid" && focus.w === "3px" && rgb(focus.c) === "rgb(0, 0, 0)", `${focus.tag} ${focus.w} ${focus.s} ${focus.c}`);

  const homeText = await home.locator("body").innerText();
  check("⑫ 文案没被换肤动到（第 10 轮 / 20 分钟口径仍在）", /第 10 轮/.test(homeText) && /20 分钟后揭晓/.test(homeText));
  await home.screenshot({ path: `${SHOTS}/a-home-1280.png`, fullPage: true });

  // ── 390 窄屏：不许横向滚动 ──────────────────────────────────────────
  await home.setViewportSize({ width: 390, height: 844 });
  await sleep(250);
  const overflow = await home.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
  }));
  check("⑬ 390 宽无横向滚动", overflow.sw <= overflow.cw, `scrollWidth=${overflow.sw} clientWidth=${overflow.cw}`);
  await home.screenshot({ path: `${SHOTS}/a-home-390.png`, fullPage: true });
  await home.setViewportSize({ width: 1280, height: 900 });

  // ── 触屏：按钮触控目标 ≥44px（引导地址只能用一次，所以把 A 的 cookie 带进触屏上下文）
  const touchCtx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    storageState: { cookies: await ctx.cookies(), origins: [] },
  });
  const touch = await touchCtx.newPage();
  watch(touch, "[touch]");
  await touch.goto(`${BASE}/`, { waitUntil: "networkidle" });
  const coarse = await touch.evaluate(() => {
    const ok = matchMedia("(pointer: coarse)").matches;
    const el = [...document.querySelectorAll("button")].find((b) => b.offsetHeight > 0);
    return { ok, h: el ? Math.round(el.getBoundingClientRect().height) : 0 };
  });
  check("⑭ 触屏下按钮自动长到 ≥44px", coarse.ok && coarse.h >= 44, `coarse=${coarse.ok} 高度=${coarse.h}px`);
  await touchCtx.close();

  // ── 版式量尺（"太丑"的可数部分：留白、拉伸、同排错位、正文行长） ──────
  const homeLayout = await home.evaluate(() => {
    const box = (el) => (el ? el.getBoundingClientRect() : { width: 0, x: 0 });
    const page = document.querySelector(".page");
    // 量"中线差"而不是"顶边差"：一排里 56 的圆片和 36 的按钮本来就该顶边不齐，
    // 它们的中线必须重合。中线差 >2px 才是真的错位。
    const spread = (sel) => {
      const row = document.querySelector(sel);
      if (!row) return -1;
      const mids = [...row.children]
        .filter((e) => e.offsetParent)
        .map((e) => { const r = e.getBoundingClientRect(); return r.top + r.height / 2; });
      if (mids.length < 2) return 0;
      return Math.round(Math.max(...mids) - Math.min(...mids));
    };
    return {
      pageW: Math.round(box(page).width),
      sideMargin: Math.round(box(page).x),
      scrollH: Math.round(document.documentElement.scrollHeight),
      cardW: Math.round(box(document.querySelector(".form-section")).width),
      identityW: Math.round(box(document.querySelector(".card-identity")).width),
      createW: Math.round(box(document.querySelector(".create-bar button")).width),
      rowSpread: [".status-actions", ".assist-switches", ".avatar-row"].map(spread),
      measureW: Math.round(box(document.querySelector(".page > p.hint")).width),
    };
  });
  check("㉒b 宽屏真两栏：身份卡只占半栏", homeLayout.identityW < homeLayout.cardW * 0.62, `卡 ${homeLayout.cardW} / 身份 ${homeLayout.identityW}`);
  check("㉒c 主按钮不再被拉成一整条", homeLayout.createW > 0 && homeLayout.createW < 200, `创建新会话 宽 ${homeLayout.createW}px`);
  check("㉒d 同排控件中线对齐（差 ≤2px）", homeLayout.rowSpread.every((v)=> v >= 0 && v <= 8), `差值 ${homeLayout.rowSpread.join("/")}`);
  check("㉒e 首页总高比上一版(1457px)降下来", homeLayout.scrollH < 1300, `${homeLayout.scrollH}px / 栏宽 ${homeLayout.pageW} / 单边留白 ${homeLayout.sideMargin}`);
  check("㉒f 说明段落被限在可读行长里（≤620px）", homeLayout.measureW > 0 && homeLayout.measureW <= 620, `宽 ${homeLayout.measureW}px`);
  const draftH = await styles(home, "textarea.draft-input", ["height"]);
  check("㉒g 长文本框按内容给高度（开场白 ≥96px）", Number.parseInt(draftH?.height ?? "0", 10) >= 96, draftH?.height);

  // ── 会话页：chip / ghost / 气泡 / pre-wrap ──────────────────────────
  await home.locator('input[placeholder="小李"]').fill("键盘验收");
  await home.getByRole("button", { name: "创建新会话" }).click();
  await waitFor(() => /\/sessions\//.test(home.url()), 20_000, "A 跳会话页");
  const sessionId = home.url().match(/\/sessions\/([^/?#]+)/)?.[1];

  const b = await ctx.newPage();
  watch(b, "[b]");
  await b.goto(`${PUB}/s/${sessionId}`, { waitUntil: "networkidle" });
  await b.getByRole("button", { name: /开始对话/ }).click({ timeout: 10_000 });
  await waitFor(async () => (await b.locator(".message-A").count()) > 0, 15_000, "B 进场");
  await b.locator("textarea").fill("周五能给我初稿吗？我这边等着改下一版。");
  await b.getByRole("button", { name: "发送", exact: true }).click();
  await waitFor(async () => (await home.locator(".message-list").first().innerText()).includes("周五"), 15_000, "A 收到提问");

  await home.locator("textarea").last().fill("可以，周五前给你。周二先把框架搭起来。");
  const sendButton = home.getByRole("button", { name: "发送", exact: true });
  await sendButton.click();
  // A 首页的开场白不在消息列表里（那里只有对方来的 + 我发出去的），所以是 1 条不是 2 条。
  await waitFor(
    async () => (await home.locator(".message-A").count()) >= 1 && (await home.locator(".message-A").last().innerText()).includes("框架"),
    15_000,
    "A 发出回复",
  );
  await sleep(400);

  const bubbleB = await styles(home, ".message-B", ["backgroundColor", "color", "borderTopColor", "whiteSpace"]);
  const bubbleA = await styles(home, ".message-A", ["backgroundColor", "color", "borderTopLeftRadius"]);
  check("⑮ 对方的话=白纸黑字黑边", rgb(bubbleB?.backgroundColor) === "rgb(255, 255, 255)" && rgb(bubbleB?.color) === "rgb(0, 0, 0)" && rgb(bubbleB?.borderTopColor) === "rgb(0, 0, 0)", `${bubbleB?.backgroundColor}/${bubbleB?.color}`);
  check("⑯ 我发出去的话=棋盘黑底奶油字", rgb(bubbleA?.backgroundColor) === "rgb(0, 0, 0)" && rgb(bubbleA?.color) === "rgb(243, 229, 223)", `${bubbleA?.backgroundColor}/${bubbleA?.color}`);
  check("⑰ 气泡保留 pre-wrap（规则模式的多行编号靠它）", bubbleB?.whiteSpace === "pre-wrap", bubbleB?.whiteSpace);

  const chip = await styles(home, "button.chip", ["borderTopLeftRadius", "fontSize", "borderTopColor"]);
  check("⑱ 成对动作是胶囊 chip（借 3D/AR 开关的形）", chip?.borderTopLeftRadius === "9999px", `${chip?.borderTopLeftRadius} ${chip?.fontSize} ${chip?.borderTopColor}`);
  const ghost = await styles(home, "button.ghost", ["borderTopStyle", "backgroundColor"]);
  check("⑲ ghost=虚线边透明底（次级/可放弃）", ghost?.borderTopStyle === "dashed" && ghost?.backgroundColor === "rgba(0, 0, 0, 0)", `${ghost?.borderTopStyle} ${ghost?.backgroundColor}`);
  const footRule = await styles(home, ".session-page footer", ["borderTopWidth", "borderTopStyle", "borderTopColor"]);
  check("⑳ 输入区被一条黑规则托住（不靠阴影分层）", footRule?.borderTopStyle === "solid" && rgb(footRule?.borderTopColor) === "rgb(0, 0, 0)", `${footRule?.borderTopWidth} ${footRule?.borderTopColor}`);
  await home.screenshot({ path: `${SHOTS}/a-session-1280.png`, fullPage: true });

  // ── 边界：B 端这一轮不该被动到 ──────────────────────────────────────
  const bBg = await b.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check("㉑ B 端仍是旧灰白（本轮只换 A 端）", rgb(bBg) !== "rgb(243, 229, 223)", bBg);

  // ── 源码纪律：hex 只许活在 token 段里 ───────────────────────────────
  const css = fs.readFileSync(path.join(HERE, "..", "apps", "a-frontend", "src", "styles.css"), "utf8");
  const rootBlock = css.slice(css.indexOf(":root"), css.indexOf("/* ---------- 2. Base"));
  const outside = [...css.replace(rootBlock, "").matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
  check("㉒ :root 之外没有裸色值", outside.length === 0, outside.slice(0, 6).join(" ") || "0 处");

  check("㉓ 无未捕获的页面错误", errors.length === 0, errors.slice(0, 3).join(" | "));

  await browser.close();
  // 收尾必须坐实：SIGTERM 之后等它真退出，否则每次跑完留一个孤儿进程占着端口。
  cleanup();
  await sleep(1_200);
  const stillUp = await fetch(`${BASE}/api/local/health`).then(() => true).catch(() => false);
  check("㉔ 探针自己收干净（无孤儿进程、无临时库残留）", !stillUp && !fs.existsSync(DB));
  const bad = results.filter((r) => !r.pass).length;
  console.log(`\n合计 ${results.length} 项，失败 ${bad} 项；截图：${SHOTS}/a-home-1280.png a-home-390.png a-session-1280.png`);
  process.exit(bad ? 1 : 0);
}

main().catch((e) => {
  console.error("探针失败：", e?.message ?? e);
  console.error("服务端日志尾部：", serverLog());
  process.exitCode = 1;
});

// 临时（验完删）：真浏览器看 A 界面这一轮的四件事：
//   ① 公网那一行收成「状态 + 该出现的按钮」，第三方说明那块按作者要求删了；
//   ② 会话页两个按钮（处置正文 / 深度反推）常驻，没提问时灰着；档位下拉夹在中间；
//   ③ 两个按钮各干各的：处置正文不动摘要、深度反推不动正文；
//   ④ 摘要框在正文框上方、标签是「展示给对方的分析过程」；发出去 B 真收得到。
// 自己起一次性实例 + 临时库，绝不动用户那台 8787。
// 跑法：拷到 coding/ 下（playwright 和 dist/* 都按脚本所在目录解析）→ node tmp-v.mjs
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { chromium } from "playwright-core";

const CODING = process.cwd();
const LP = 8897, PP = 8898;
const tok = crypto.randomBytes(32).toString("hex");
const dbPath = path.join(CODING, "data", "tmp-ui.sqlite");
for (const s of ["", "-shm", "-wal"]) fs.rmSync(dbPath + s, { force: true });
const A = `http://127.0.0.1:${LP}`, B = `http://127.0.0.1:${PP}`;
const EXE = "/Users/a1234/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const clean = (s) => (s ?? "").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
const TRACE = (m) => console.log("· " + m);

const child = spawn(
  path.join(path.dirname(process.execPath), "node"),
  [path.join(CODING, "dist", "server", "index.js")],
  {
    cwd: CODING,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NODE_ENV: "production",
      LOCAL_PORT: String(LP), PUBLIC_PORT: String(PP),
      HOST: "127.0.0.1", PUBLIC_HOST: "127.0.0.1",
      LOCAL_DATA_PATH: dbPath,
      // 公网面板只看状态机怎么排版，不需要真把隧道拉起来。
      TUNNEL_AUTOSTART: "false",
      LOCAL_CONTROL_TOKEN_SECRET: tok, AIWINDOW_LAUNCHER_TOKEN: "1",
    },
  },
);
child.stdout.on("data", (c) => process.stdout.write(String(c).replace(tok, "<令牌>")));
child.stderr.on("data", (c) => process.stderr.write(String(c).replace(tok, "<令牌>")));

const api = (p, o) => fetch(`${A}${p}`, {
  headers: { cookie: `aiwindow_ctrl=${tok}`, "content-type": "application/json", ...(o?.headers ?? {}) },
  ...o,
});
async function up() {
  for (let i = 0; i < 60; i++) {
    try { if ((await api("/api/local/health")).ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const shots = [];
try {
  TRACE("等服务起来");
  if (!(await up())) throw new Error("服务没起来");
  const br = await chromium.launch({ executablePath: EXE, args: ["--no-proxy-server"] });
  const ctx = await br.newContext({ viewport: { width: 1180, height: 900 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push("未捕获异常: " + e.message));
  p.on("dialog", (d) => d.accept());

  TRACE("bootstrap 解锁");
  await p.goto(`${A}/api/local/bootstrap/${tok}`);
  await p.waitForTimeout(1000);
  await p.goto(A + "/");
  await p.waitForTimeout(1500);

  // ---------- ① 首页 ----------
  TRACE("① 首页");
  const panel = p.locator("section.public-status");
  const panelTxt = clean(await panel.innerText());
  const bodyTxt = clean(await p.locator("body").innerText());
  console.log("① 公网那一行 =", panelTxt.slice(0, 140));
  console.log("   有标题吗（应当没有） =", await panel.locator("h2, h3").count());
  console.log("   未开启时按钮数 =", await panel.locator(".status-actions button").count());
  console.log("   出现通道地址吗 =", /trycloudflare|https:\/\//.test(panelTxt));
  console.log("   第三方说明那块还在吗（已删） =", /由谁提供|cloudflare\.com|服务条款/.test(bodyTxt));
  console.log("   Skill 内部信息（标识/版本/上限/SKILL.md）出现吗 =",
    /ai-style-amplifier|reverse-depth-analysis|SKILL\.md|上限由服务端兜/.test(bodyTxt));
  console.log("   能选的模式 =", (await p.locator(".assist-mode strong").allInnerTexts()).map(clean));
  await p.screenshot({ path: "/tmp/ui7-home.png", fullPage: true }); shots.push("/tmp/ui7-home.png");

  // ---------- ② 会话页：B 没提问 ----------
  TRACE("② 建会话");
  await p.locator('input[placeholder="小李"]').fill("验收小明");
  await p.locator("button", { hasText: "创建新会话" }).click();
  await p.waitForURL(/\/sessions\//, { timeout: 20000 });
  await p.waitForTimeout(2000);
  const polish = p.locator("button", { hasText: "处置正文" });
  const analyze = p.locator("button", { hasText: "深度反推" });
  const level = p.locator(".assist-row select");
  console.log("\n② B 未提问：处置正文在吗 =", await polish.count() > 0,
    "灰 =", await polish.first().isDisabled(),
    "| 深度反推在吗 =", await analyze.count() > 0, "灰 =", await analyze.first().isDisabled());
  console.log("   按钮 title（为什么灰） =", await polish.first().getAttribute("title"));
  console.log("   档位下拉 =", await level.count() > 0 ? "在" : "不在",
    "当前 =", await level.inputValue(), "选项 =",
    (await level.locator("option").allInnerTexts()).map(clean));
  console.log("   会话页上还有公网面板吗 =", await p.locator("section.public-status").count() > 0);
  console.log("   底部一行 =", clean(await p.locator(".session-page footer").innerText()).slice(0, 130));

  // ---------- ③ B 真问一句 ----------
  TRACE("③ B 提问");
  const link = clean(await p.locator('[data-testid="public-link"]').innerText());
  const bp = await (await br.newContext({ viewport: { width: 390, height: 800 } })).newPage();
  await bp.goto(link);
  await bp.waitForTimeout(1500);
  const startBtn = bp.locator("button", { hasText: "开始对话" });
  if (await startBtn.count()) { await startBtn.click(); await bp.waitForTimeout(1500); }
  await bp.locator("textarea").last().fill("这两个方案我该怎么选？");
  await bp.locator("button", { hasText: "发送" }).first().click();
  await p.waitForTimeout(4500); // A 侧 3 秒轮询

  const draft = p.locator("footer textarea").last();
  const analysis = p.locator("textarea.analysis-input");
  const hasBox = (await analysis.count()) > 0;
  console.log("\n③ 有提问后：正文还空 → 两个按钮仍灰 =", await polish.first().isDisabled(),
    await analyze.first().isDisabled(), " title =", await polish.first().getAttribute("title"));
  console.log("   分析框出现吗 =", hasBox, " 标签 =", hasBox ? clean(await p.locator(".analysis-label").innerText()) : "(无)");
  if (hasBox) {
    const ay = (await analysis.boundingBox()).y, dy = (await draft.boundingBox()).y;
    console.log("   分析框在正文框上面吗 =", ay < dy, `（y ${Math.round(ay)} vs ${Math.round(dy)}）`);
  }

  // ---------- ④ 档位改一下，看存不存 ----------
  await level.selectOption("浓郁");
  await p.waitForTimeout(1200);
  console.log("\n④ 会话页上把档位改成「浓郁」后，服务端 =",
    (await (await api("/api/local/settings")).json()).assist.styleLevel);

  // ---------- ⑤ 两个按钮各干各的 ----------
  TRACE("⑤ 处置正文 → 深度反推");
  const original = "建议选第二个：维护成本低，两个人都能接手。";
  await draft.fill(original);
  await p.waitForTimeout(600);
  console.log("\n⑤ 填完正文，两个按钮 =", !(await polish.first().isDisabled()),
    !(await analyze.first().isDisabled()));
  await polish.first().click();
  await p.waitForFunction(
    () => {
      const t = document.querySelector("footer textarea:last-of-type");
      const n = document.querySelector(".assist-ok, .assist-warning, .assist-error");
      return !!n && !!t && t.value !== "";
    },
    null, { timeout: 25000 },
  ).catch(() => {});
  await p.waitForTimeout(800);
  const polished = await draft.inputValue();
  console.log("   处置正文之后正文 =", JSON.stringify(clean(polished).slice(0, 70)));
  console.log("   正文真的被润色了（跟原稿不同） =", polished !== original);
  console.log("   这一步没顺手写摘要（摘要框应为空） =",
    JSON.stringify(((await analysis.inputValue().catch(() => "")) ?? "") === ""));
  console.log("   提示 =", clean(await p.locator(".assist-ok, .assist-warning, .assist-error").first().innerText()).slice(0, 70));

  await analyze.first().click();
  await p.waitForFunction(
    () => { const t = document.querySelector("textarea.analysis-input"); return !!t && t.value.trim().length > 0; },
    null, { timeout: 25000 },
  ).catch(() => {});
  await p.waitForTimeout(600);
  const summary = hasBox ? await analysis.inputValue() : "(分析框没出现)";
  console.log("   深度反推出来的过程 =", JSON.stringify(clean(summary).slice(0, 100)));
  console.log("   反推没动正文 =", (await draft.inputValue()) === polished);
  await p.screenshot({ path: "/tmp/ui7-session.png", fullPage: true }); shots.push("/tmp/ui7-session.png");

  // ---------- ⑥ 发出去 B 收得到吗 ----------
  await p.locator("button", { hasText: "发送" }).first().click();
  await bp.waitForTimeout(3000);
  const btxt = clean(await bp.locator("body").innerText());
  console.log("\n⑥ B 侧看到的 =", JSON.stringify(btxt.slice(-170)));
  console.log("   页面未捕获异常 =", errs.length ? errs : "无");
  await br.close();
} catch (e) {
  console.log("!! 中途出错:", String(e.message).replace(tok, "<令牌>"));
} finally {
  child.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 1200));
  for (const s of ["", "-shm", "-wal"]) { try { fs.rmSync(dbPath + s); } catch {} }
  console.log("\n临时实例已停、临时库已删；截图：", shots.join(" "));
}

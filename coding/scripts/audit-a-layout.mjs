// 版式量尺：把 A 端两页的真实盒子量出来，用数字判断"丑在哪"。
// 跑法：cd coding && npm run check:layout
// 只看数、不改东西；换肤前后各跑一次，改没改好靠差值说话。
import { spawn } from "node:child_process";
import net from "node:net";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, "..", "dist", "server", "index.js");
const NODE = process.execPath;
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on("error", reject);
  });
const LOCAL_PORT = await freePort();
const PUBLIC_PORT = await freePort();
const BASE = `http://127.0.0.1:${LOCAL_PORT}`;
const PW = path.join(process.env.HOME ?? "", "Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
const DB = path.join(os.tmpdir(), `lay-${process.pid}.sqlite`);
const token = crypto.randomBytes(24).toString("base64url");
const server = spawn(NODE, [ENTRY], {
  env: { ...process.env, NODE_ENV: "production", LOCAL_PORT, PUBLIC_PORT, HOST: "127.0.0.1", PUBLIC_HOST: "127.0.0.1",
    LOCAL_DATA_PATH: DB, TUNNEL_AUTOSTART: "false", LOG_LEVEL: "error", LOCAL_CONTROL_TOKEN_SECRET: token, AIWINDOW_LAUNCHER_TOKEN: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let reaped = false;
const cleanup = () => { if (reaped) return; reaped = true; try { server.kill("SIGTERM"); } catch {} setTimeout(() => { try { server.kill("SIGKILL"); } catch {} }, 1500).unref?.(); for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (fs.existsSync(f)) fs.rmSync(f, { force: true }); };
process.on("exit", cleanup);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms, label) => { const until = Date.now() + ms; while (Date.now() < until) { try { if (await fn()) return; } catch {} await sleep(150); } throw new Error(`超时：${label}`); };

const REPORT = () => {
  const px = (n) => Math.round(n);
  const box = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return { w: px(r.width), h: px(r.height), x: px(r.x), y: px(r.y + window.scrollY), pad: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map((v) => px(parseFloat(v) || 0)).join("/"), border: cs.borderTopWidth + " " + cs.borderTopStyle, radius: cs.borderTopLeftRadius, bg: cs.backgroundColor, fs: cs.fontSize, lh: cs.lineHeight, gap: cs.rowGap, mb: cs.marginBottom }; };
  const name = (el) => { const t = (el.innerText || el.value || "").trim().replace(/\s+/g, " "); return el.tagName.toLowerCase() + (el.className ? "." + String(el.className).split(/\s+/)[0] : "") + (t ? ` «${t.slice(0, 14)}»` : ""); };
  const out = { scrollH: px(document.documentElement.scrollHeight), vw: window.innerWidth, vh: window.innerHeight };
  const page = document.querySelector(".page");
  out.page = page ? { ...box(page), maxW: getComputedStyle(page).maxWidth } : null;
  out.kids = page ? [...page.children].map((el) => ({ n: name(el), ...box(el) })) : [];
  // 卡片内控件宽度是否参差
  out.fields = [...document.querySelectorAll(".form-section, .assist-panel")].map((card) => {
    const ctrls = [...card.querySelectorAll("input, textarea, select, button")].filter((e) => e.offsetParent && e.type !== "radio");
    return { card: name(card), cardW: box(card).w, ctrls: ctrls.slice(0, 8).map((e) => ({ n: name(e), w: box(e).w, h: box(e).h, y: box(e).y })) };
  });
  // 行内元素顶边是否齐平（同一年纪的东西不该错位）
  out.rows = [...document.querySelectorAll(".row, .assist-row, .assist-switches, .counters, .avatar-row, .status-actions, header")].map((r) => {
    const items = [...r.children].filter((e) => e.offsetParent);
    const ys = items.map((e) => e.getBoundingClientRect().top);
    const hs = items.map((e) => px(e.getBoundingClientRect().height));
    return { row: name(r), count: items.length, topSpread: ys.length ? px(Math.max(...ys) - Math.min(...ys)) : 0, heights: hs.join(",") };
  });
  // 正文行长：中文字数 ≈ 宽/字号，>22 字就该收栏宽（手册②§16.3）
  out.measure = [...document.querySelectorAll(".page p, .page .hint, .message p, .form-section label")]
    .filter((e) => e.offsetParent && e.textContent?.trim() && e.getBoundingClientRect().width >= 80)
    .map((e) => {
      const cs = getComputedStyle(e);
      return {
        w: px(e.getBoundingClientRect().width),
        size: cs.fontSize,
        chars: (e.textContent || "").trim().length,
        txt: (e.textContent || "").trim().slice(0, 16),
      };
    })
    .sort((x, y) => x.w / parseFloat(x.size) < 0 ? 0 : y.chars / (y.w / parseFloat(y.size)) - x.chars / (x.w / parseFloat(x.size)))
    .slice(0, 6);
  return out;
};

const print = (tag, r) => {
  console.log(`\n### ${tag}  视口 ${r.vw}  页面总高 ${r.scrollH}px  栏宽 ${r.page?.w}px(max ${r.page?.maxW})  左右留白 ${r.page?.x}px×2`);
  console.log("| 顶层块 | 宽 | 高 | 内距 | 边 | 圆角 | 底色 | 字号 | 行高 |");
  console.log("|---|---|---|---|---|---|---|---|---|");
  for (const k of r.kids) console.log(`| ${k.n} | ${k.w} | ${k.h} | ${k.pad} | ${k.border} | ${k.radius} | ${k.bg} | ${k.fs} | ${k.lh} |`);
  console.log("\n[正文行长] 每行约多少中文字");
  for (const m of r.measure ?? []) {
    console.log(`  ${m.w}px @ ${m.size} → 约 ${Math.round(m.w / parseFloat(m.size))} 字/行（全文 ${m.chars} 字）«${m.txt}»`);
  }
  console.log("\n[卡片内控件参差]");
  for (const f of r.fields) console.log(` ${f.card}（卡宽 ${f.cardW}）→ ` + f.ctrls.map((c) => `${c.n} ${c.w}×${c.h}`).join(" | "));
  console.log("\n[同一行的顶边差 / 各自高度]");
  for (const x of r.rows) console.log(` ${x.row} 子项${x.count} 顶边差${x.topSpread}px 高度 ${x.heights}`);
};

async function main() {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/api/local/health`)).status === 200) break; } catch {} await sleep(300); }
  const browser = await chromium.launch({ executablePath: PW, args: ["--no-proxy-server", "--no-first-run"] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  await fetch(`${BASE}/api/local/settings`, { headers: { cookie: `aiwindow_ctrl=${token}` } });
  await p.goto(`${BASE}/api/local/bootstrap/${token}`, { waitUntil: "domcontentloaded" });
  await p.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await p.locator('input[placeholder="小李"]').fill("键盘验收");
  await p.locator('textarea').first().waitFor();
  print("A 首页 @1280", await p.evaluate(REPORT));
  await p.setViewportSize({ width: 390, height: 844 });
  await sleep(300);
  print("A 首页 @390", await p.evaluate(REPORT));
  await p.setViewportSize({ width: 1280, height: 900 });
  await p.locator("button.primary").click();
  await waitFor(() => /\/sessions\//.test(p.url()), 20000, "进会话页");
  await sleep(1200);
  print("A 会话页 @1280", await p.evaluate(REPORT));
  await p.screenshot({ path: "/tmp/aiwindow-layout-session-before.png", fullPage: true });
  // B 端只量一下现状宽度体系，供下一轮参考
  const b = await ctx.newPage();
  const sid = p.url().match(/\/sessions\/([^/?#]+)/)?.[1];
  await b.goto(`http://127.0.0.1:${PUBLIC_PORT}/s/${sid}`, { waitUntil: "networkidle" });
  await b.getByRole("button", { name: /开始对话/ }).click().catch(() => {});
  await sleep(800);
  print("B 会话页 @1280（本轮不动，仅存档）", await b.evaluate(REPORT));
  await browser.close();
  cleanup();
}
main().catch((e) => { console.error("量尺失败：", e?.message ?? e); process.exitCode = 1; });

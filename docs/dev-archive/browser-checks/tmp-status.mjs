// 临时：照用户 A 的方式打开工作台，把每个 /api 响应打出来，定位「读不到通道状态」
import { chromium } from "playwright-core";
import fs from "node:fs";
const EXE = "/Users/a1234/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const TOK = fs.readFileSync("/tmp/tok.txt", "utf8").trim();
const b = await chromium.launch({ executablePath: EXE, args: ["--no-proxy-server"] });
const ctx = await b.newContext();
const p = await ctx.newPage();
p.on("response", async (r) => {
  if (!r.url().includes("/api/local/status")) return;
  let body = "";
  try { body = (await r.text()).slice(0, 400); } catch {}
  console.log(`  status → ${r.status()} ${body}`);
});
p.on("console", (m) => { if (m.type() === "error") console.log("  console.error:", m.text().slice(0, 200)); });
p.on("pageerror", (e) => console.log("  pageerror:", String(e.message).slice(0, 300)));
await p.goto(`http://127.0.0.1:8787/api/local/bootstrap/${TOK}`, { waitUntil: "domcontentloaded" });
await p.waitForTimeout(4000);
const t = (await p.locator("body").innerText()).replace(/\s+/g, " ");
console.log("\n页面文本（前 600 字）:\n" + t.slice(0, 600));
console.log("\n含「读不到通道状态」 =", t.includes("读不到通道状态"));
console.log("含「公网」 =", t.includes("公网"));
await p.screenshot({ path: "/tmp/shot-status.png", fullPage: true });
await b.close();

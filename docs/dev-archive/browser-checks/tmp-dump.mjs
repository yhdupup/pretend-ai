// 探路（临时）：解锁 → 建会话 → 把会话页与 B 页的真实文案打出来
import { chromium } from "playwright-core";
import fs from "node:fs";
const EXE = "/Users/a1234/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const TOK = fs.readFileSync("/tmp/tok.txt", "utf8").trim();
const A = "http://127.0.0.1:8787";
const clean = (s) => (s ?? "").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
const b = await chromium.launch({ executablePath: EXE, args: ["--no-proxy-server"] });
const p = await (await b.newContext()).newPage();
p.on("dialog", (d) => d.accept());
await p.goto(`${A}/api/local/bootstrap/${TOK}`);
await p.waitForTimeout(1200);
// 先看首页：清空称呼，观察灰按钮
const name = p.locator('input[placeholder="小李"]');
console.log("称呼当前值 =", JSON.stringify(await name.inputValue()));
await name.fill("");
await p.waitForTimeout(600);
const btn = p.locator("button", { hasText: "创建新会话" });
console.log("清空后 disabled =", await btn.isDisabled());
console.log("首页提示 =", clean(await p.locator("body").innerText()).match(/[^。\n]{0,30}(不能为空|填|灰)[^。\n]{0,20}/g)?.slice(0, 4));
await name.fill("验收小明");
await p.waitForTimeout(400);
await btn.click();
await p.waitForURL(/\/sessions\//, { timeout: 15000 });
await p.waitForTimeout(2500);
console.log("\n########## A 会话页全文 ##########");
console.log(clean(await p.locator("body").innerText()));
console.log("\n########## A 会话页按钮 ##########");
console.log((await p.locator("button").evaluateAll((e) => e.map((x) => (x.textContent || "").trim().slice(0, 24) + (x.disabled ? "[灰]" : "")))).join(" | "));
console.log("\n########## 链接卡片区域 HTML 片段 ##########");
const cardHtml = await p.locator('[class*="link"], [class*="card"]').first().innerHTML().catch(() => "(找不到卡片容器)");
console.log(cardHtml.replace(/\s+/g, " ").slice(0, 1200));
await p.screenshot({ path: "/tmp/shot-a-card.png", fullPage: true });
// B 页
const link = clean(await p.locator("body").innerText()).match(/http:\/\/\S+\/s\/[0-9a-f-]+/)?.[0];
console.log("\n抓到的链接 =", link);
if (link) {
  const pb = await (await b.newContext({ viewport: { width: 390, height: 780 } })).newPage();
  await pb.goto(link);
  await pb.waitForTimeout(1800);
  console.log("\n########## B 首屏全文 ##########");
  console.log(clean(await pb.locator("body").innerText()));
  console.log("B 按钮 =", (await pb.locator("button").evaluateAll((e) => e.map((x) => (x.textContent || "").trim().slice(0, 20) + (x.disabled ? "[灰]" : "")))).join(" | "));
  await pb.screenshot({ path: "/tmp/shot-b-page.png", fullPage: true });
}
await b.close();

// 探路用（临时）：把 A 的真实界面结构打出来，别靠猜写断言。
import { chromium } from "playwright-core";
const EXE =
  "/Users/a1234/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const A = "http://127.0.0.1:8787";
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-proxy-server"] });

const dump = async (label, page) => {
  const txt = (await page.locator("body").innerText()).replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n");
  const inputs = await page.locator("input,textarea,select").evaluateAll((els) =>
    els.map((e) => `${e.tagName.toLowerCase()}[${e.type || ""}] ph="${e.placeholder || ""}" val=${e.value ? "(" + String(e.value).slice(0, 14) + ")" : ""}`),
  );
  const btns = await page.locator("button").evaluateAll((els) =>
    els.map((e) => `${(e.textContent || "").trim().slice(0, 22)}${e.disabled ? "[灰]" : ""}`),
  );
  console.log(`\n########## ${label} @ ${page.url()}`);
  console.log("--- 文案 ---\n" + txt.slice(0, 700));
  console.log("--- 输入框 ---", inputs.join(" | ") || "(无)");
  console.log("--- 按钮 ---", btns.join(" | ") || "(无)");
};

// 1) 未解锁
const p0 = await (await browser.newContext()).newPage();
await p0.goto(`${A}/`, { waitUntil: "domcontentloaded" });
await p0.waitForTimeout(1500);
await dump("未解锁（新 profile，无 cookie）", p0);

// 2) 解锁后首页
const fs = await import("node:fs");
const TOK = fs.readFileSync("/tmp/tok.txt", "utf8").trim();
const pa = await (await browser.newContext()).newPage();
await pa.goto(`${A}/api/local/bootstrap/${TOK}`);
await pa.waitForTimeout(1500);
await dump("已解锁 · 首页", pa);
for (const path of ["/create", "/sessions/new", "/settings"]) {
  const r = await pa.goto(A + path, { waitUntil: "domcontentloaded" }).catch(() => null);
  if (!r) continue;
  if (r.status() === 200 && !pa.url().includes(path)) {
    console.log(`\n(路由 ${path} 不存在，被 SPA 退回 → ${pa.url()})`);
    continue;
  }
  await pa.waitForTimeout(900);
  await dump(`已解锁 · ${path}`, pa);
}
// 3) 首页上点「创建新会话」后到哪
await pa.goto(`${A}/`, { waitUntil: "domcontentloaded" });
await pa.waitForTimeout(900);
const b = pa.locator("button", { hasText: "创建新会话" });
if (await b.count()) {
  await b.first().click();
  await pa.waitForTimeout(2000);
  await dump("点了「创建新会话」之后", pa);
}
await browser.close();

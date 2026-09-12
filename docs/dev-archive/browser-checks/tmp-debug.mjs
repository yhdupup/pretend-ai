// 调试（临时）：把两个页面的 /api 请求与响应打出来，看 B 的消息到底有没有发出去
import { chromium } from "playwright-core";
import fs from "node:fs";
const EXE = "/Users/a1234/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const TOK = fs.readFileSync("/tmp/tok.txt", "utf8").trim();
const A = "http://127.0.0.1:8787";
const b = await chromium.launch({ executablePath: EXE, args: ["--no-proxy-server"] });
const log = (tag, p) => {
  p.on("response", async (r) => {
    if (!r.url().includes("/api/")) return;
    let body = "";
    try { body = (await r.text()).slice(0, 160); } catch {}
    console.log(`  [${tag}] ${r.request().method()} ${r.url().replace("http://127.0.0.1:", "")} → ${r.status()} ${body}`);
  });
  p.on("console", (m) => { if (m.type() === "error") console.log(`  [${tag} console.error] ${m.text().slice(0, 140)}`); });
  p.on("pageerror", (e) => console.log(`  [${tag} pageerror] ${String(e.message).slice(0, 140)}`));
};
const pa = await (await b.newContext()).newPage(); log("A", pa);
await pa.goto(`${A}/api/local/bootstrap/${TOK}`);
await pa.waitForTimeout(1500);
await pa.locator('input[placeholder="小李"]').fill("调试小明");
await pa.locator("button", { hasText: "创建新会话" }).click();
await pa.waitForURL(/\/sessions\//, { timeout: 15000 });
await pa.waitForTimeout(1500);
const link = (await pa.locator("body").innerText()).match(/http:\/\/\S+\/s\/[0-9a-f-]+/)?.[0];
console.log("链接 =", link);

const pb = await (await b.newContext({ viewport: { width: 390, height: 800 } })).newPage(); log("B", pb);
await pb.goto(link);
await pb.waitForTimeout(2000);
console.log("B 首屏 =", (await pb.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 80));
console.log("→ 点开始对话");
await pb.locator("button", { hasText: "开始对话" }).click();
await pb.waitForTimeout(2500);
console.log("B 点完 =", (await pb.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 80));
console.log("→ 发一条消息");
await pb.locator("textarea").first().fill("调试问题一");
await pb.keyboard.press("Enter");
await pb.waitForTimeout(3000);
console.log("B 发后 =", (await pb.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 120));
console.log("B 输入框 disabled =", await pb.locator("textarea").first().isDisabled());
await pa.reload();
await pa.waitForTimeout(4000);
const at = (await pa.locator("body").innerText()).replace(/\s+/g, " ");
console.log("A 页面 =", at.slice(0, 260));
console.log("A 有处理按钮 =", await pa.locator("button", { hasText: "处理草稿" }).count());
await b.close();

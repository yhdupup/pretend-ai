// 临时：验 PRD §5.5/§6.7 键盘规则 + §7.4.3 自动折叠（真 Chromium，含 CDP 造组词态）
import { chromium } from "playwright-core";
import fs from "node:fs";
const EXE = "/Users/a1234/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const TOK = fs.readFileSync("/tmp/tok.txt", "utf8").trim();
const A = "http://127.0.0.1:8787";
const out = [];
const say = (s) => { out.push(s); console.log(s); };

const b = await chromium.launch({ executablePath: EXE, args: ["--no-proxy-server"] });
const pa = await (await b.newContext()).newPage();
await pa.goto(`${A}/api/local/bootstrap/${TOK}`);
await pa.waitForTimeout(1500);
await pa.locator('input[placeholder="小李"]').fill("键盘验收");
await pa.locator("button", { hasText: "创建新会话" }).click();
await pa.waitForURL(/\/sessions\//, { timeout: 15000 });
await pa.waitForTimeout(1500);
const link = (await pa.locator("body").innerText()).match(/http:\/\/\S+\/s\/[0-9a-f-]+/)?.[0];
const pb = await (await b.newContext({ viewport: { width: 390, height: 820 } })).newPage();
await pb.goto(link, { waitUntil: "domcontentloaded" });
await pb.waitForTimeout(1500);
await pb.locator("button", { hasText: "开始对话" }).click();
await pb.waitForTimeout(1200);

const Bt = async () => (await pb.locator("body").innerText()).replace(/\s+/g, " ");
const At = async () => (await pa.locator("body").innerText()).replace(/\s+/g, " ");
const waitSee = async (read, needle, ms = 14000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if ((await read()).includes(needle)) return true; await new Promise(r => setTimeout(r, 400)); }
  return false;
};

/* ── 1. B：Shift+Enter 只换行，不发送 ── */
const box = pb.locator("textarea").first();
await box.waitFor({ state: "visible", timeout: 8000 });
await box.click();
await box.type("第一行");
await pb.keyboard.press("Shift+Enter");
await pb.keyboard.type("第二行");
await pb.waitForTimeout(900);
const val = await box.inputValue();
say(`${/第一行\n第二行/.test(val) && !(await Bt()).includes("第一行") ? "✅" : "❌"} B Shift+Enter 换行不发送 → 框内=${JSON.stringify(val)}｜页面上已出现消息=${(await Bt()).includes("第一行")}`);

/* ── 2. B：裸 Enter 发送 ── */
await box.fill("回车能发吗");
await pb.keyboard.press("Enter");
const sent = await waitSee(At, "回车能发吗", 8000);
say(`${sent ? "✅" : "❌"} B 裸 Enter 直接发送（A 端 3s 轮询内收到）`);

/* ── 2.5 A 先回一条，把 B 解锁（B 一条只能一问，这是 PRD §5.5 的锁定规则） ── */
await pa.bringToFront();
const d0 = pa.locator("textarea").nth(0);
await d0.waitFor({ state: "visible", timeout: 8000 });
await d0.fill("可以，那就晚上");
const s0 = pa.locator("button", { hasText: /^发送$/ }).first();
for (let i = 0; i < 24 && !(await s0.isEnabled().catch(() => false)); i++) await pa.waitForTimeout(500);
await s0.click({ timeout: 8000 });
await waitSee(Bt, "可以，那就晚上", 14000);
await pb.waitForTimeout(600);

/* ── 3. B：真·输入法组词态按 Enter 不发送（CDP） ── */
const cdp = await pb.context().newCDPSession(pb);
await box.click();
await cdp.send("Input.imeSetComposition", { text: "组词", selectionStart: 2, selectionEnd: 2 });
await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, isComposing: true });
await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, isComposing: true });
await pb.waitForTimeout(1200);
const t3 = await Bt();
const compNotSent = !t3.includes("组词中") && !(await At()).includes("组词");
const stillInBox = (await box.inputValue()).includes("组词");
say(`${compNotSent && stillInBox ? "✅" : "❌"} B 组词态 Enter 没发送（PRD §5.5）→ 字还留在框里=${stillInBox}`);
await cdp.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 }).catch(() => {});
await box.fill("");

/* ── 4. A：Enter 发送 / Shift+Enter 换行 ── */
await pa.bringToFront();
const d = pa.locator("textarea").nth(0);
await d.click();
await d.type("A的第一行");
await pa.keyboard.press("Shift+Enter");
await pa.keyboard.type("A的第二行");
await pa.waitForTimeout(900);
const aVal = await d.inputValue();
const aNoSend = !(await Bt()).includes("A的第一行");
say(`${/A的第一行\nA的第二行/.test(aVal) && aNoSend ? "✅" : "❌"} A Shift+Enter 换行不发送 → ${JSON.stringify(aVal)}`);
await d.fill("A用回车发出去");
await pa.keyboard.press("Enter");
const got = await waitSee(Bt, "A用回车发出去", 10000);
say(`${got ? "✅" : "❌"} A 裸 Enter 发送成功（B 收到）`);

/* ── 5. B：思考块播完自动折叠（PRD §7.4.3）——走 A 手写摘要这条路，不碰处理按钮 ── */
await pb.bringToFront();
await box.click();
await box.fill("再问一句，晚上可以吗");
await pb.locator("button", { hasText: /^发送$/ }).first().click();
await waitSee(At, "再问一句", 14000);
await pa.bringToFront();
const sendA = pa.locator("button", { hasText: /^发送$/ }).first();
await d.fill("这条回复带一段手写摘要");
const pq = pa.locator('textarea[placeholder*="可分析过程"]').first();
await pq.waitFor({ state: "visible", timeout: 8000 });
await pq.fill("先确认你要的是周三晚上，再给结论。");
for (let i = 0; i < 24 && !(await sendA.isEnabled().catch(() => false)); i++) await pa.waitForTimeout(500);
await sendA.click({ timeout: 8000 });
const arrived = await waitSee(Bt, "先确认你要的是周三晚上", 20000);
// 逐字 16 字 ≈ 700 + 16*45 + 1200 ≈ 2.6s，再给足余量等它自己收起来
let headNow = "";
for (let i = 0; i < 30; i++) {
  await pb.bringToFront();
  headNow = await pb.locator(".thinking-head").first().innerText().catch(() => "");
  if (/展开思考过程/.test(headNow)) break;
  await pb.waitForTimeout(500);
}
const collapsedNow = /展开思考过程/.test(headNow);
say(`${arrived && collapsedNow ? "✅" : "❌"} B 摘要播完自动折叠 → 头部文案="${headNow.replace(/\s+/g, " ")}"｜全文到达=${arrived}`);

/* ── 6. 手动展开还能看全文（§7.4.4） ── */
await pb.locator(".thinking-head").first().click();
await pb.waitForTimeout(500);
const expanded = (await Bt()).includes("先确认你要的是周三晚上");
say(`${expanded ? "✅" : "❌"} 点一下能重新展开看全文`);

/* ── 7. 刷新后直接是折叠态、不重播（冒烟 §五.12） ── */
await pb.reload({ waitUntil: "domcontentloaded" });
await pb.waitForTimeout(1200);
const headAfter = await pb.locator(".thinking-head").first().innerText().catch(() => "");
const noReplay = !(await Bt()).includes("正在整理思路");
say(`${noReplay && /展开思考过程/.test(headAfter) ? "✅" : "❌"} 刷新后不重播、直接折叠态 → 无「正在整理思路」=${noReplay}｜头部="${headAfter.replace(/\s+/g, " ")}"`);

await b.close();
fs.writeFileSync("/tmp/kb.txt", out.join("\n"));

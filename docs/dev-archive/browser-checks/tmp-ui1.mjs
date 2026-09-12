// 临时验收驱动（不是交付物）：用真 Chromium 跑「脚本测不到、要人看」的手工项。
import { chromium } from "playwright-core";
import fs from "node:fs";

const EXE =
  "/Users/a1234/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const TOK = fs.readFileSync("/tmp/tok.txt", "utf8").trim();
const A = "http://127.0.0.1:8787";
const out = [];
const rec = (id, ok, detail = "") => {
  out.push(`${ok ? "✅" : "❌"} ${id}${detail ? " → " + detail : ""}`);
  console.log(out[out.length - 1]);
};

const browser = await chromium.launch({
  executablePath: EXE,
  args: ["--no-proxy-server"], // 本机两个端口都不该走系统代理
});
// A 与 B 用两个独立 context：模拟两台设备，cookie 不共享
const ctxA = await browser.newContext();
const ctxB = await browser.newContext({
  storageState: { cookies: [], origins: [] },
});
const pa = await ctxA.newPage();
const pb = await ctxB.newPage();
pa.on("dialog", (d) => d.accept());

// ---------- 阶段一 §四.1：未解锁时 A 给可操作提示，不是一屏 403 ----------
{
  const p = await (await browser.newContext()).newPage();
  const resp = await p.goto(`${A}/`, { waitUntil: "domcontentloaded" });
  const body = (await p.textContent("body"))?.replace(/\s+/g, " ").trim() ?? "";
  rec(
    "P1 未解锁直接开 A：状态码 + 页面说人话",
    resp.status() === 200 && body.includes("解锁"),
    `HTTP ${resp.status()}｜${body.slice(0, 70)}`,
  );
  await p.context().close();
}

// ---------- 解锁（阶段五：一次性引导地址） ----------
{
  const resp = await pa.goto(`${A}/api/local/bootstrap/${TOK}`, {
    waitUntil: "domcontentloaded",
  });
  await pa.waitForTimeout(1200);
  const url = pa.url();
  rec(
    "P5 引导地址解锁并跳回工作台、地址栏不留令牌",
    resp.status() === 200 && !url.includes(TOK.slice(0, 12)),
    `${url}｜HTTP ${resp.status()}`,
  );
  const cookies = await ctxA.cookies(A);
  const c = cookies.find((x) => x.name === "aiwindow_ctrl");
  rec(
    "P5 控制 Cookie：HttpOnly + SameSite=Strict + 绑 127.0.0.1",
    !!c && c.httpOnly && c.sameSite === "Strict" && c.domain === "127.0.0.1",
    c ? `domain=${c.domain} httpOnly=${c.httpOnly} sameSite=${c.sameSite}` : "没有 cookie",
  );
}

// ---------- 阶段二 §五.1：字段没填完时创建按钮是灰的 ----------
{
  const btn = pa.locator("button", { hasText: "创建新会话" });
  const disabledAtStart = await btn.isDisabled().catch(() => null);
  const hint = (await pa.textContent(".hint, .field-hint, form"))?.replace(/\s+/g, " ") ?? "";
  await btn.click({ force: true }).catch(() => {});
  const stillHome = pa.url().endsWith("/") || pa.url() === `${A}/`;
  rec(
    "P2 未填身份时「创建新会话」灰掉且点不动",
    disabledAtStart === true && stillHome,
    `disabled=${disabledAtStart} 仍在首页=${stillHome}`,
  );
  const labels = (await pa.locator("label").allTextContents()).map((s) => s.replace(/\s+/g, " ").trim());
  rec("P2 首页字段清单可读", labels.length >= 3, labels.join(" / ").slice(0, 120));
  void hint;
}

// ---------- 填身份 → 建会话 ----------
let linkHref = null;
{
  await pa.fill('input[placeholder="小李"]', "验收小明").catch(async () => {
    const first = pa.locator("label input").first();
    await first.fill("验收小明");
  });
  const ta = pa.locator("textarea");
  if (await ta.count()) await ta.first().fill("这条是验收用的揭晓留言");
  await pa.locator("button", { hasText: "创建新会话" }).waitFor({ timeout: 5000 });
  const btn = pa.locator("button", { hasText: "创建新会话" });
  rec("P2 填完后按钮变可点", (await btn.isDisabled()) === false);
  await btn.click();
  await pa.waitForURL(/\/sessions\//, { timeout: 15000 }).catch(() => {});
  rec("P2 建会话后进入会话页", /\/sessions\//.test(pa.url()), pa.url());

  // 链接卡片：阶段三 §六.1 + 阶段五 pending 文案
  const card = (await pa.locator("body").innerText()).replace(/\s+/g, " ");
  const m = card.match(/http:\/\/127\.0\.0\.1:8788\/s\/[0-9a-f-]+/);
  linkHref = m?.[0] ?? null;
  const copyBtn = pa.locator("button", { hasText: /复制/ });
  const copyDisabled = (await copyBtn.count()) ? await copyBtn.first().isDisabled() : null;
  const gateText = /本机|只有这台电脑|公网/.test(card);
  rec(
    "P3+P5 未验证可达时复制按钮点不动、并解释原因",
    linkHref !== null && copyDisabled === true && gateText,
    `link=${linkHref ? "有" : "无"} copyDisabled=${copyDisabled}`,
  );
  await pa.screenshot({ path: "/tmp/shot-a-session.png", fullPage: true });
}

// ---------- 阶段二 §五.5：B 首屏是「开始对话」而不是自动绑定 ----------
{
  await pb.goto(linkHref, { waitUntil: "domcontentloaded" });
  await pb.waitForTimeout(1500);
  const txt = (await pb.locator("body").innerText()).replace(/\s+/g, " ");
  const hasStart = /开始对话/.test(txt);
  const boundAlready = /已绑定|对方正在输入/.test(txt);
  rec("P2 B 首屏给「开始对话」，不自动绑链接", hasStart && !boundAlready, txt.slice(0, 90));
  await pb.screenshot({ path: "/tmp/shot-b-first.png", fullPage: true });
}

fs.writeFileSync("/tmp/uireport1.txt", out.join("\n") + "\n");
await browser.close();
console.log("\n=== 阶段1 小结 ===");
console.log(out.filter((l) => l.startsWith("❌")).length + " 红 / " + out.length + " 项");

// 临时：解锁态真跑 —— ①引导链接换 Cookie ②工作台读得到状态 ③验收页 19 项全跑
import { chromium } from "playwright-core";

const EXE =
  "/Users/a1234/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const BOOT = process.argv[2];
if (!BOOT) throw new Error("用法：node tmp-unlock-selftest.mjs <一次性引导地址>");

const b = await chromium.launch({
  executablePath: EXE,
  args: ["--no-proxy-server"],
});
const ctx = await b.newContext();
const p = await ctx.newPage();
const errs = [];
p.on("console", (m) => {
  if (m.type() === "error") errs.push("console: " + m.text().slice(0, 160));
});
p.on("pageerror", (e) => errs.push("pageerror: " + String(e).slice(0, 160)));

// ① 引导地址（和双击启动时浏览器做的事一样）
await p.goto(BOOT, { waitUntil: "domcontentloaded" });
await p.waitForTimeout(4000);
console.log("引导后地址:", p.url().replace(/c9755[0-9a-f]+/, "<token>"));

// ② 工作台：状态读得到吗
const wb = (await p.locator("body").innerText()).replace(/[ \t]+/g, " ");
console.log("含「会话已失效」:", wb.includes("本机控制会话已失效"));
console.log("含「读不到通道状态」:", wb.includes("读不到通道状态"));
const pub = wb.match(/公网链接[\s\S]{0,220}/);
console.log("--- 工作台「公网链接」那块 ---\n" + (pub ? pub[0].replace(/\n{2,}/g, "\n") : "(没找到)"));
await p.screenshot({ path: "/tmp/unlock-workbench.png", fullPage: true });

// ③ 验收页
await p.goto("http://127.0.0.1:8787/selftest", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(2500);
const runBtn = p.getByRole("button", { name: /运行全部检查/ });
await runBtn.click();
await p.waitForFunction(
  () => !/正在运行|运行中…/.test(document.body.innerText),
  null,
  { timeout: 90_000 },
);
await p.waitForTimeout(1500);
const t = (await p.locator("body").innerText()).replace(/[ \t]+/g, " ");
const count = (re) => (t.match(re) ?? []).length;
const lines = t.split("\n").map((s) => s.trim()).filter(Boolean);
const bad = lines.filter(
  (l) => /❌|失败|FAIL|未通过|跳过/.test(l) && !/0 项跳过|0 跳过/.test(l),
);
const head = t.match(/(\d+)\s*✅[^\n]*|通过[^\n]{0,60}|(\d+)\s*项通过[^\n]*/g);
console.log("\n--- 验收页汇总 ---");
console.log("汇总行:", head ? head.slice(0, 6).join(" | ") : "(没匹配到)");
console.log("✅ 出现次数:", count(/✅/g), " ❌:", count(/❌/g), " 跳过:", count(/跳过/g));
console.log("红/黄条目:", bad.length ? bad.slice(0, 12).join(" ⏎ ") : "无");
console.log("页面报错:", errs.length ? [...new Set(errs)].join(" ⏎ ") : "无");
await p.screenshot({ path: "/tmp/unlock-selftest.png", fullPage: true });
await p.locator("body").innerText().then((x) =>
  import("node:fs").then((fs) => fs.writeFileSync("/tmp/selftest-text.txt", x)),
);
console.log("\n截图：/tmp/unlock-workbench.png  /tmp/unlock-selftest.png；全文 /tmp/selftest-text.txt");
await b.close();

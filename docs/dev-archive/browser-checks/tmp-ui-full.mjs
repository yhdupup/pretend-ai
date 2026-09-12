// 临时验收驱动（跑完删除，不是交付物）
// 覆盖「脚本测不到、要人看」的手工项：阶段一 §四 / 阶段二 §五 / 阶段三 §六（非公网） / 阶段四 §五（可自动化部分）
// 本轮按用户要求排除公网：服务用 TUNNEL_AUTOSTART=false 启动，公网项一律 SKIP 不判红。
import { chromium } from "playwright-core";
import fs from "node:fs";

const EXE =
  "/Users/a1234/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const TOK = fs.readFileSync("/tmp/tok.txt", "utf8").trim();
const A = "http://127.0.0.1:8787";
const R = [];
const txt = (s) => (s ?? "").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
async function check(id, fn) {
  try {
    const [cond, detail] = await fn();
    R.push([cond ? "PASS" : "FAIL", id, detail ?? ""]);
    console.log(`${cond ? "✅" : "❌"} ${id}${detail ? " → " + detail : ""}`);
  } catch (e) {
    R.push(["ERROR", id, String(e?.message).slice(0, 110)]);
    console.log(`💥 ${id} → ${String(e?.message).slice(0, 110)}`);
  }
}
const skip = (id, why) => { R.push(["SKIP", id, why]); console.log(`⏭️ ${id} → ${why}`); };

async function waitSee(read, needle, ms = 14000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if ((await read()).includes(needle)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-proxy-server"] });
const ctxA = await browser.newContext();
const pa = await ctxA.newPage();
pa.on("dialog", (d) => d.accept());
const At = async () => txt(await pa.locator("body").innerText());
const ctxB = await browser.newContext({ viewport: { width: 390, height: 820 } });
const pb = await ctxB.newPage();
pb.on("dialog", (d) => d.accept());
const Bt = async () => txt(await pb.locator("body").innerText());

/* ── 阶段一 §四.1 ── */
await check("P1·手工1 未解锁打开 A：可操作提示，不是一屏 403", async () => {
  const p = await (await browser.newContext()).newPage();
  const r = await p.goto(`${A}/`, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(1000);
  const t = txt(await p.locator("body").innerText());
  await p.context().close();
  return [r.status() === 200 && !/\b403\b/.test(t) && t.includes("读不到通道状态") && t.includes("创建新会话"), t.match(/.{0,18}读不到通道状态/)?.[0]];
});

/* ── 解锁 ── */
await check("P5 一次性引导地址解锁、地址栏不留令牌、Cookie 三重限制", async () => {
  const r = await pa.goto(`${A}/api/local/bootstrap/${TOK}`, { waitUntil: "domcontentloaded" });
  await pa.waitForTimeout(1400);
  const c = (await ctxA.cookies(A)).find((x) => x.name === "aiwindow_ctrl");
  return [r.status() === 200 && !pa.url().includes(TOK.slice(0, 10)) && !!c && c.httpOnly && c.sameSite === "Strict" && c.domain === "127.0.0.1",
    `${pa.url()}｜${c ? "HttpOnly+Strict+127.0.0.1" : "无 cookie"}`];
});

/* ── 阶段二 §五.1 表单门槛 ── */
await check("P2·手工1 称呼清空 → 按钮变灰并说明缺哪几项", async () => {
  const name = pa.locator('input[placeholder="小李"]');
  const saved = await name.inputValue();
  await name.fill("");
  await pa.waitForTimeout(500);
  const btn = pa.locator("button", { hasText: "创建新会话" });
  const t = await At();
  const cond = (await btn.isDisabled()) === true && /都不能为空/.test(t);
  await name.fill(saved || "验收小明");
  await pa.waitForTimeout(400);
  return [cond && (await btn.isDisabled()) === false, `${t.match(/[^。\n]{0,26}都不能为空/)?.[0]}｜填回后 disabled=${await btn.isDisabled()}`];
});

/* ── 模式开关在首页（AssistPanel 的 radio） ── */
// 模式开关：点 label（点 input 会在 PATCH 期间撞上 disabled）；点完等 busy  clear
async function setMode(label) {
  await pa.locator(".assist-mode", { hasText: label }).first().click({ force: true });
  await pa.waitForTimeout(1300);
  const on = await pa.locator(".assist-mode", { hasText: label }).first().evaluate((el) => {
    const i = el.querySelector("input[type=radio]");
    return { checked: !!i?.checked, disabled: !!i?.disabled };
  });
  return on;
}
await check("P4·手工1 三档模式在界面上都在", async () => {
  const t = await At();
  return [/人工模式/.test(t) && /本地规则模式/.test(t) && /我的模型/.test(t), ["人工模式", "本地规则模式", "我的模型"].filter((k) => t.includes(k)).join("/")];
});

let modelState = null;
await check("P4·手工2 选「我的模型」→ 给出中文原因而不是转圈", async () => {
  modelState = await setMode("我的模型");
  const t = await At();
  const hit = t.match(/[^。\n]{0,30}(还没配密钥|是空的|填齐)[^。\n]{0,18}/)?.[0] ?? "";
  return [modelState.checked === true && hit !== "" && !/加载中/.test(t), `${t.match(/还没配密钥[^。\n]{0,26}/)?.[0] ?? hit}`];
});
await check("P4·手工3 密钥框是掩码输入（type=password），且未保存时不回显", async () => {
  const key = pa.locator('label:has-text("API Key") input').first();
  const type = await key.getAttribute("type");
  const ph = await key.getAttribute("placeholder");
  return [type === "password", `type=${type}｜placeholder=${ph}`];
});
await setMode("人工模式");

/* ── 建会话①（人工模式） ── */
async function newSession() {
  await pa.locator('input[placeholder="小李"]').fill("验收小明");
  await pa.waitForTimeout(300);
  await pa.locator("button", { hasText: "创建新会话" }).click();
  await pa.waitForURL(/\/sessions\//, { timeout: 15000 });
  await pa.waitForTimeout(1400);
  return { url: pa.url(), link: (await At()).match(/http:\/\/\S+\/s\/[0-9a-f-]+/)?.[0] ?? null, page: await At() };
}
const s1 = await newSession();
console.log(`   （会话① ${s1.url?.split("/").pop()?.slice(0, 8)}）`);

await check("P3·手工1 未开公网：卡片如实标「本机地址（只有你这台电脑能打开）」", async () => {
  return [/本机地址（只有你这台电脑能打开）/.test(s1.page) && /还没有可用的公网地址/.test(s1.page), s1.page.match(/本机地址[^。\n]{0,26}/)?.[0]];
});
await check("P3·手工1 复制按钮点不动且 title 解释为什么", async () => {
  const btn = pa.locator("button", { hasText: "复制链接" }).first();
  const title = (await btn.getAttribute("title")) ?? "";
  return [(await btn.isDisabled()) === true && title !== "", `disabled=true｜title=${title}`];
});
await check("P5 公网面板未开启时是「未开启 + 开启公网链接」，不报错", async () => {
  const btns = await pa.locator("button").evaluateAll((e) => e.map((x) => (x.textContent || "").trim()));
  return [/未开启/.test(s1.page) && btns.includes("开启公网链接"), btns.filter((b) => /开启公网|停止|换一条|再验/.test(b)).join("|")];
});
skip("P3 真隧道 8 步 / 跨网络手机打开 / 面板 开启→变绿→停止", "本轮按要求排除公网（TUNNEL_AUTOSTART=false，没起 cloudflared）");

/* ── B 首屏 + 绑定 ── */
await check("P2·手工5 B 首屏是「开始对话」，没有自动绑定", async () => {
  await pb.goto(s1.link, { waitUntil: "domcontentloaded" });
  await pb.waitForTimeout(1500);
  const t = await Bt();
  return [/开始对话/.test(t) && !/对方正在输入/.test(t), t.slice(0, 42)];
});
await pb.locator("button", { hasText: "开始对话" }).click();
await pb.waitForTimeout(1200);

/* ── 人工模式下没有处理草稿按钮（阶段四 §五.1 前半） ── */
await check("P4·手工1 人工模式：B 提问后会话页仍没有「处理草稿」按钮", async () => {
  await pb.locator("textarea").first().fill("今晚吃什么");
  await pb.locator("button", { hasText: /^发送$/ }).first().click();
  await pb.waitForTimeout(3800); // A 端 3 秒一轮轮询
  const n = await pa.locator("button", { hasText: "处理草稿" }).count();
  const t = await At();
  return [n === 0 && /今晚吃什么/.test(t), `处理按钮 ${n} 个｜A 已看到问题=${/今晚吃什么/.test(t)}`];
});
await check("P4·手工1 切回「本地规则」立刻出现处理按钮（不重启、不刷新会话页）", async () => {
  await pa.locator("button", { hasText: "← 首页" }).click();
  await pa.waitForTimeout(1000);
  await setMode("本地规则模式");
  await pa.goto(s1.url, { waitUntil: "domcontentloaded" });
  await pa.waitForTimeout(1600);
  const n = await pa.locator("button", { hasText: "处理草稿" }).count();
  return [n > 0, `处理按钮 ${n} 个`];
});

/* ── 阶段二 §五.2 轮次与倒计时 ── */
await check("P2·手工2 轮次显示 n/10 且 B 单发不计轮", async () => {
  const t = await At();
  return [/0\s*\/\s*10/.test(t) && /还差 10 轮/.test(t), (t.match(/轮次[^\n]{0,8}/)?.[0] ?? "") + " " + (t.match(/还差 \d+ 轮/)?.[0] ?? "")];
});
await check("P2·手工2 倒计时在走（服务端时间校准）", async () => {
  const a = (await At()).match(/(\d{2}:\d{2})/)?.[1];
  await pa.waitForTimeout(2600);
  const b = (await At()).match(/(\d{2}:\d{2})/)?.[1];
  return [!!a && !!b && a !== b, `${a} → ${b}`];
});

/* ── 阶段二 §五.6 正在输入 + 阶段四 §五.14 生成期间锁 B 输入 ── */
const draftTA = () => pa.locator("textarea").nth(0);
const procTA = () => pa.locator('textarea[placeholder*="可分析过程"]');
await check("P2·手工6/P4·手工14 B 发出后立刻锁住输入框并显示「对方正在输入…」", async () => {
  const box = pb.locator("textarea").first();
  const before = await box.isDisabled();
  await box.fill("周末去爬山吗");
  await pb.locator("button", { hasText: /^发送$/ }).first().click();
  await pb.waitForTimeout(250);
  const t = await Bt();
  const disabledAfter = await pb.locator("textarea").first().isDisabled();
  return [before === false && disabledAfter === true && /对方正在输入/.test(t), `发前 disabled=${before} → 发后 disabled=${disabledAfter}｜提示=${/对方正在输入/.test(t)}`];
});
await check("P4·手工5 处理草稿期间正文区锁住（placeholder 变成生成中提示）", async () => {
  await draftTA().fill("去，早八点南门。");
  await pa.waitForTimeout(300);
  if (await procTA().count()) await procTA().first().fill("先确认对方问的是去不去，还是集合时间。");
  const btn = pa.locator("button", { hasText: "处理草稿" });
  await btn.first().click();
  await pa.waitForTimeout(120);
  const ph = await draftTA().getAttribute("placeholder");
  const dis = await draftTA().isDisabled();
  return [dis === true && /正在生成/.test(ph ?? ""), `disabled=${dis}｜placeholder=${ph}`];
});
await check("P4·手工5 结果落进编辑区并给中文说明（冒烟文档写的「已改写」在界面上不存在）", async () => {
  await pa.waitForTimeout(2600);
  const v = await draftTA().inputValue();
  const t = await At();
  const note = t.match(/[^。\n]{0,30}(生成，检查完再发|已按[^\n]{0,18}生成)[^。\n]{0,10}/)?.[0] ?? "";
  return [v !== "去，早八点南门。" && note !== "", `正文已被改写=${v !== "去，早八点南门。"}`.slice(0, 60) + `｜说明=${note}`];
});
await check("P4·手工6 改正文 → 出现「对不上号」条，两条出路都在", async () => {
  await draftTA().fill((await draftTA().inputValue()).replace("。", "！"));
  await pa.waitForTimeout(900);
  const t = await At();
  const btns = (await pa.locator("button").allTextContents()).map(txt);
  return [/对不上号/.test(t) && btns.some((b) => b === "重新处理") && btns.some((b) => /确认/.test(b)), t.match(/[^。\n]{0,24}对不上号[^。\n]{0,12}/)?.[0] ?? "" ];
});
await check("P4·手工6 走「确认这条摘要」这条路能发出去", async () => {
  await pa.locator("button", { hasText: "确认这条摘要" }).click();
  await pa.waitForTimeout(800);
  await pa.locator("button", { hasText: /^发送$/ }).click();
  await pb.waitForTimeout(3200);
  const t = await Bt();
  return [/！/.test(t) || /早八点/.test(t), t.match(/(早八点[^\n]{0,10}|！)/)?.[0] ? "B 收到改写后的正文" : t.slice(0, 50)];
});
await check("P2·手工2 A 回复后轮次 +1、B 侧「正在输入」消失", async () => {
  const t = await At();
  const bt = await Bt();
  return [/1\s*\/\s*10/.test(t) && !/对方正在输入/.test(bt), `A 轮次 ${t.match(/(\d+)\s*\/\s*10/)?.[1]}｜B 提示消失=${!/对方正在输入/.test(bt)}`];
});
await check("P4·手工11/13 B 侧思考块出现后折叠成一行（可展开）", async () => {
  let sawThinking = false;
  for (let i = 0; i < 8; i++) { if (/我在思考|展开|收起/.test(await Bt())) { sawThinking = true; break; } await pb.waitForTimeout(700); }
  const t = await Bt();
  await pb.screenshot({ path: "/tmp/shot-b-thinking.png", fullPage: true });
  return [sawThinking && /展开|收起/.test(t), t.match(/(我在思考|展开|收起)[^\n]{0,12}/g)?.slice(0, 2).join(" ‖ ") ?? ""];
});
await check("P4·手工16 思考块文本无内部禁词、无 Markdown 痕迹", async () => {
  const t = await Bt();
  const banned = ["草稿", "模型", "后台", "轮次", "倒计时", "skill", "Skill", "token", "提示词", "密钥", "**", "##", "```"];
  const block = t.match(/(我在思考[\s\S]{0,420}|展开[\s\S]{0,420})/)?.[0] ?? t;
  const hit = banned.filter((w) => block.includes(w));
  return [hit.length === 0, hit.length ? `出现 ${hit.join(",")}` : "干净"];
});
await check("P4·手工12 刷新后不重播，直接折叠态", async () => {
  const before = (await Bt()).length;
  await pb.reload({ waitUntil: "domcontentloaded" });
  await pb.waitForTimeout(1000);
  const t1 = await Bt();
  await pb.waitForTimeout(1600);
  const t2 = await Bt();
  return [!/正在整理思路/.test(t1) && /展开/.test(t1) && Math.abs(t2.length - t1.length) < 30,
    `刷新后无「正在整理思路」=${!/正在整理思路/.test(t1)}｜1.6s 内文本漂移 ${Math.abs(t2.length - t1.length)} 字`];
});
await check("P4·手工8 连点处理：第二次被挡（灰/限速中文提示），且提示会自己消失", async () => {
  await pb.locator("textarea").first().fill("那几点集合？");
  await pb.locator("button", { hasText: /^发送$/ }).first().click();
  await pb.waitForTimeout(3800);
  const btn = pa.locator("button", { hasText: "处理草稿" }).first();
  await draftTA().fill("八点。");
  await btn.click();
  await pa.waitForTimeout(150);
  const greyed = await btn.isDisabled().catch(() => null);
  await btn.click({ force: true }).catch(() => {});
  await pa.waitForTimeout(1200);
  const t1 = await At();
  const warned = /点得太快|慢一点|等几秒/.test(t1);
  await pa.waitForTimeout(4200);
  const t2 = await At();
  const gone = !/点得太快|慢一点|等几秒/.test(t2);
  return [(greyed === true || warned) && gone, `第2次 disabled=${greyed}｜限速提示出现过=${warned}｜几秒后自己消失=${gone}`];
});
await check("P4·手工7 「可分析过程」里写「草稿」→ 确认被拒并给原因", async () => {
  if (!(await procTA().count())) return [false, "没有过程输入框（摘要开关可能已关）"];
  await procTA().first().fill("我把这段草稿润色一下。");
  await pa.waitForTimeout(700);
  const conf = pa.locator("button", { hasText: "确认这条摘要" });
  if (await conf.count()) { await conf.first().click().catch(() => {}); await pa.waitForTimeout(1200); }
  const t = await At();
  const rejected = /不能|含有|不合规|没过自检|不要|禁|对不上/.test(t);
  return [rejected, t.match(/[^。\n]{0,34}(没过自检|不能|不合规|对不上号)[^。\n]{0,16}/)?.[0] ?? "没看到拒绝提示"];
});
await check("P4·手工10 关掉「生成可分析过程」→ 处理时不再出摘要；已发出去的思考块仍在", async () => {
  await pa.goto(A, { waitUntil: "domcontentloaded" });
  await pa.waitForTimeout(1000);
  const swLabel = pa.locator('label.switch:has-text("生成可分析过程")').first();
  const input = swLabel.locator("input[type=checkbox]");
  const before = await input.isChecked();
  await swLabel.click();
  await pa.waitForTimeout(1400);
  const after = await input.isChecked();
  await pa.goto(s1.url, { waitUntil: "domcontentloaded" });
  await pa.waitForTimeout(1500);
  const boxGone = (await procTA().count()) === 0;
  await pa.goto(A, { waitUntil: "domcontentloaded" });
  await pa.waitForTimeout(900);
  await pa.locator('label.switch:has-text("生成可分析过程")').first().click().catch(() => {});
  await pa.waitForTimeout(900);
  return [before !== after && boxGone, `开关 ${before}→${after}｜关掉后过程输入框消失=${boxGone}`];
});

await pa.goto(s1.url, { waitUntil: "domcontentloaded" });
await pa.waitForTimeout(1600);

/* ── 打满 10 轮 → 揭晓（阶段二 §五.7 / 阶段四 §五.15） ── */
const loopLog = [];
for (let round = 2; round <= 10; round++) {
  const q = `第 ${round} 问：再确认下`;
  const a = `第 ${round} 答：就按这个来。`;
  await pb.locator("textarea").first().waitFor({ state: "visible", timeout: 15000 });
  const unlocked = await pb.locator("textarea").first().isEnabled().catch(() => false);
  if (!unlocked) { loopLog.push(`第${round}轮：B 输入框仍锁着，先等 A 回复`); await pb.waitForTimeout(4000); }
  await pb.locator("textarea").first().fill(q).catch(() => {});
  await pb.locator("button", { hasText: /^发送$/ }).first().click().catch(() => {});
  const seenByA = await waitSee(At, q);
  if (!seenByA) { loopLog.push(`第${round}轮：A 没看到问题`); break; }
  await draftTA().waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
  await draftTA().fill(a).catch(() => {});
  const sendBtn = pa.locator("button", { hasText: /^发送$/ }).first();
  await sendBtn.waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
  const canSend = await sendBtn.isEnabled().catch(() => false);
  if (!canSend) { loopLog.push(`第${round}轮：A 发送按钮是灰的`); break; }
  await sendBtn.click().catch(() => {});
  const gotByB = await waitSee(Bt, a);
  if (!gotByB) { loopLog.push(`第${round}轮：B 没收到回复`); break; }
}
console.log("   （十轮循环记录：" + (loopLog.join("；") || "全部走完") + "）");
await check("P2 满 10 轮 → A 侧 10/10 或已揭晓", async () => {
  const t = await At();
  return [/10\s*\/\s*10/.test(t) || /已揭晓|已完成第 10 轮/.test(t), (t.match(/(\d+)\s*\/\s*10/)?.[0] ?? "") + " " + (t.match(/已完成第 10 轮|已揭晓/)?.[0] ?? "")];
});
await check("P4·手工15 B 侧第 10 轮正文播完才弹揭晓窗", async () => {
  let sawReveal = false; let bodyFull = false;
  for (let i = 0; i < 20; i++) {
    const t = await Bt();
    if (/第 10 答：就按这个来。/.test(t)) bodyFull = true;
    if (/知道了，继续聊天/.test(t)) { sawReveal = true; if (bodyFull) break; }
    await pb.waitForTimeout(600);
  }
  await pb.screenshot({ path: "/tmp/shot-b-reveal.png", fullPage: true });
  return [sawReveal && bodyFull, `正文完整=${bodyFull}｜弹窗=${sawReveal}`];
});
await check("P2·手工7 弹窗含真名+留言，只有「知道了，继续聊天」一个出口", async () => {
  const t = await Bt();
  const btns = (await pb.locator("button").allTextContents()).map(txt).filter(Boolean);
  return [/验收小明/.test(t) && btns.includes("知道了，继续聊天") && !btns.some((b) => /取消|关闭|跳过|稍后/.test(b)), `按钮=${btns.join("/")}｜含真名=${/验收小明/.test(t)}`];
});
await check("P2·手工7 点遮罩关不掉", async () => {
  const dlg = pb.locator("text=知道了，继续聊天");
  const bb = await dlg.boundingBox();
  await pb.mouse.click(4, 4);
  await pb.waitForTimeout(700);
  const still = /知道了，继续聊天/.test(await Bt());
  await pb.keyboard.press("Escape");
  await pb.waitForTimeout(700);
  const stillAfterEsc = /知道了，继续聊天/.test(await Bt());
  void bb;
  return [still && stillAfterEsc, `点左上角遮罩后仍在=${still}｜Esc 后仍在=${stillAfterEsc}`];
});
await pb.locator("button", { hasText: "知道了，继续聊天" }).click();
await pb.waitForTimeout(1400);
await check("P2·手工7 关掉后会话不关，还能继续聊", async () => {
  await pb.locator("textarea").first().fill("那我不去了");
  await pb.locator("button", { hasText: /^发送$/ }).first().click();
  await pb.waitForTimeout(1800);
  const t = await Bt();
  return [/那我不去了/.test(t) && !/已经结束/.test(t), t.slice(-40)];
});
await check("P2·手工7 刷新不再自动弹，「查看揭晓信息」入口在", async () => {
  await pb.reload({ waitUntil: "domcontentloaded" });
  await pb.waitForTimeout(2000);
  const t = await Bt();
  const btns = (await pb.locator("button").allTextContents()).map(txt);
  return [!/知道了，继续聊天/.test(t) && btns.some((b) => /查看揭晓/.test(b)), `按钮=${btns.filter((b) => /揭晓/.test(b)).join("/") || "(无)"}｜自动弹=${/知道了/.test(t)}`];
});

/* ── 会话②：立即揭晓预览 + 结束清理 + 作废措辞 ── */
await pa.goto(A, { waitUntil: "domcontentloaded" });
await pa.waitForTimeout(900);
const s2 = await newSession();
const pd = await (await browser.newContext({ viewport: { width: 390, height: 820 } })).newPage();
await pd.goto(s2.link, { waitUntil: "domcontentloaded" });
await pd.waitForTimeout(1200);
await pd.locator("button", { hasText: "开始对话" }).click();
await pd.waitForTimeout(900);
await pd.locator("textarea").first().fill("你到底是谁呀");
await pd.locator("button", { hasText: /^发送$/ }).first().click();
await pd.waitForTimeout(3800);
await check("P2·手工3 手点「立即揭晓」→ 出现「B 现在看到的」预览且会话不关", async () => {
  await pa.locator("button", { hasText: "立即揭晓" }).click();
  await pa.waitForTimeout(2000);
  const t = await At();
  return [/B 现在看到的/.test(t) && !/已结束/.test(t), t.match(/B 现在看到的[\s\S]{0,50}/)?.[0].replace(/\n/g, " ")];
});
await check("P2·手工3 手点原因优先：A 写「你点了「立即揭晓」」", async () => {
  const t = await At();
  return [/你点了「立即揭晓」/.test(t), t.match(/(你点了「立即揭晓」|已完成第 10 轮|距创建已满)/)?.[0]];
});
await check("P1·手工3/P3·手工4 结束后 B 重开：只有结束措辞，历史一条都不露", async () => {
  await pa.locator("button", { hasText: "结束并清理" }).click();
  await pa.waitForTimeout(1600);
  await pd.goto(s2.link, { waitUntil: "domcontentloaded" });
  await pd.waitForTimeout(1600);
  const t = txt(await pd.locator("body").innerText());
  return [!t.includes("你到底是谁呀") && /(已经结束|结束了|打不开|作废|不存在)/.test(t) && !/10 轮|轮次|正在输入/.test(t), t.slice(0, 70)];
});
await check("P2·手工4 结束后 A 首页列表里这条消失", async () => {
  await pa.goto(A, { waitUntil: "domcontentloaded" });
  await pa.waitForTimeout(1500);
  const t = await At();
  return [!t.includes(s2.link ?? "___"), `列表里还有这条链接=${t.includes(s2.link ?? "")}`];
});

/* ── 快捷键（阶段四 §五.9 可自动化的一半） ── */
await check("P4·手工9(全) 输入法组词态 Enter 不发送（PRD §320/§434）", async () => {
  const sK = await newSession();
  const px = await (await browser.newContext({ viewport: { width: 390, height: 820 } })).newPage();
  await px.goto(sK.link, { waitUntil: "domcontentloaded" });
  await px.waitForTimeout(1200);
  await px.locator("button", { hasText: "开始对话" }).click();
  await px.waitForTimeout(900);
  const box = px.locator("textarea").first();
  await box.click();
  await box.evaluate((el) => el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
  await box.type("组词中");
  await px.keyboard.press("Enter");
  await px.waitForTimeout(1500);
  const t = txt(await px.locator("body").innerText());
  const notSent = !/组词中/.test(t);
  await box.evaluate((el) => el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
  await px.context().close();
  return [notSent, `组词态按 Enter 没发出去=${notSent}（PRD 要求必须不发送）`];
});
await check("P4·手工9(半) Enter 与 Ctrl+Enter 都能发送（B 侧）", async () => {
  const s3 = await newSession();
  const px = await (await browser.newContext({ viewport: { width: 390, height: 820 } })).newPage();
  await px.goto(s3.link, { waitUntil: "domcontentloaded" });
  await px.waitForTimeout(1200);
  await px.locator("button", { hasText: "开始对话" }).click();
  await px.waitForTimeout(900);
  const box = px.locator("textarea").first();
  await box.fill("单回车测试");
  await box.press("Enter");
  await px.waitForTimeout(2000);
  const t1 = txt(await px.locator("body").innerText());
  await box.fill("组合键测试");
  await box.press("Control+Enter");
  await px.waitForTimeout(1400);
  const t2 = txt(await px.locator("body").innerText());
  await px.context().close();
  return [/单回车测试/.test(t1) && /组合键测试/.test(t2), `Enter 发送=${/单回车测试/.test(t1)}｜Ctrl+Enter 发送=${/组合键测试/.test(t2)}`];
});
skip("P4·手工9(半) 中文输入法联想态按 Enter 不发送", "Playwright 没有真 IME 组合态，这条只能人眼");
skip("P4·手工4 填对 key→测试连接通过 / 重启后未配置但档位仍在", "要用你的真 key 打外网，本轮不碰（E2E 已验：失败只回 502:类型码、不回显密钥、密钥随进程蒸发）");
skip("P2·手工2 改系统时钟倒计时不跳变", "改本机时钟影响整台机器，不适合自动化");
skip("P1·手工2 A/B 观感互不串（人眼）", "状态码与路由隔离已由 E2E 16/17 项与 B 静态产物断言覆盖");

fs.writeFileSync("/tmp/uireport.txt", R.map(([s, i, d]) => `${s}\t${i}\t${d}`).join("\n") + "\n");
const n = (k) => R.filter((x) => x[0] === k).length;
console.log(`\n=== 浏览器手工项小结 === PASS ${n("PASS")} / FAIL ${n("FAIL")} / ERROR ${n("ERROR")} / SKIP ${n("SKIP")}`);
await browser.close();

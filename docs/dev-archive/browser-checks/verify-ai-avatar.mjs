// 归档探针（不是交付物）：真浏览器验「假 AI 的头像」这一轮改动 ——
//   ① 创建窗口里那个四选一下拉确实没了，换成一个上传入口，默认显示打包进来的那张图；
//   ② 上传/粘贴后浏览器端压成 160×160 正方形（比身份头像的 256 小一档，因为它跟着会话 JSON 走）；
//   ③ 两个头像选择器共用一条全局粘贴监听，图只进「最后被碰到的」那一个，不能一张图变两张脸；
//   ④ 建完会话，B 端的脸就是这张上传图；不上传的会话是默认图，而且这张图在 B 的静态白名单里、
//      带得上一年 immutable 缓存（这条是当初为什么不走 public/ 根路径的全部理由）。
//
// 自己起一次性实例 + 临时库（8899/8900），绝不动用户那台 8787。
// 跑法：cd coding → cp ../docs/dev-archive/browser-checks/verify-ai-avatar.mjs tmp-ai-avatar.mjs → node tmp-ai-avatar.mjs
//（要拷进 coding 才解析得到 playwright-core：node 按脚本所在位置找依赖，不看 cwd）
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { chromium } from "playwright-core";

const CODING = process.cwd();
const LP = 8899, PP = 8900;
const tok = crypto.randomBytes(32).toString("hex");
const dbPath = path.join(CODING, "data", "tmp-ai-avatar.sqlite");
for (const s of ["", "-shm", "-wal"]) fs.rmSync(dbPath + s, { force: true });
const A = `http://127.0.0.1:${LP}`, B = `http://127.0.0.1:${PP}`;
const EXE = "/Users/a1234/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const TRACE = (m) => console.log("· " + m);
const ok = [], bad = [];
const check = (name, pass, detail = "") =>
  (pass ? ok : bad).push(`${name}${detail ? " — " + detail : ""}`);

// 上传图的内联体积上限（字符）：闸在 shared/avatars 的 400_000，那是「能不能收」；
// 这里盯的是「值不值」——这张图跟着会话 JSON 每一遍下发，命中不了浏览器缓存。
const MAX_DATA_URL_CHARS = 200_000;
// 默认图必须长成打包器的样子：/assets/ai-avatar-<哈希>.jpg（根路径 /ai-avatar.jpg 会被 404）
const ASSET_URL_RE = /^\/assets\/ai-avatar-[A-Za-z0-9_-]+\.jpg$/;

const child = spawn(path.join(path.dirname(process.execPath), "node"),
  [path.join(CODING, "dist", "server", "index.js")], {
    cwd: CODING, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "production",
      LOCAL_PORT: String(LP), PUBLIC_PORT: String(PP),
      HOST: "127.0.0.1", PUBLIC_HOST: "127.0.0.1",
      LOCAL_DATA_PATH: dbPath, TUNNEL_AUTOSTART: "false",
      LOCAL_CONTROL_TOKEN_SECRET: tok, AIWINDOW_LAUNCHER_TOKEN: "1" } });
const swallow = (c) => process.stdout.write(String(c).replace(tok, "<令牌>"));
child.stdout.on("data", swallow); child.stderr.on("data", swallow);

async function up() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${A}/api/local/health`)).ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// 在页面里画一张歪图（300×200，非正方形）：既要验「居中裁方」，也要验「缩到 160」
const makePng = (page, color = "#c0392b") => page.evaluate(([color]) => {
  const c = document.createElement("canvas");
  c.width = 300; c.height = 200;
  const x = c.getContext("2d");
  x.fillStyle = color; x.fillRect(0, 0, 300, 200);
  return c.toDataURL("image/png");
}, [color]);

// 合成一次粘贴：files 有货 / 只有 items 两条通路（老脚本验过的写法）
const paste = (page, b64, via = "files") => page.evaluate(([b64, mode]) => {
  const bin = atob(b64.split(",")[1]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const file = new File([bytes], "paste.png", { type: "image/png" });
  const dt = new DataTransfer();
  if (mode === "items") Object.defineProperty(dt, "files", { value: [] });
  dt.items.add(file);
  const ev = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt });
  document.body.dispatchEvent(ev);
  return ev.defaultPrevented;
}, [b64, via]);

// 固定 sleep 在这里会假失败：压图走 canvas，一次几十到几百毫秒，机器慢的时候越过 900ms。
// 所以要「等到变成我们要的那个样子」，超时才认输。
async function waitSrc(loc, good, ms = 6000) {
  const until = Date.now() + ms;
  let v = null;
  for (;;) {
    v = await loc.getAttribute("src").catch(() => null);
    if (good(v)) return v;
    if (Date.now() > until) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}

// 选择器必须走 locator 链。写成 p.locator(".avatar-field >> nth=1 .avatar-preview img")
// 会被解析成 nth("1 .avatar-preview img")：CSS 尾巴被 nth 吞掉，结果就是干等 30s 超时。
let OWNER, AI;

try {
  if (!(await up())) throw new Error("服务没起来");
  const br = await chromium.launch({ executablePath: EXE, args: ["--no-proxy-server"] });
  const ctx = await br.newContext({ viewport: { width: 1280, height: 1000 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push("未捕获异常: " + e.message));

  TRACE("bootstrap 解锁 → 首页（bootstrap 那页自己会跳回 /，先让它跳完）");
  await p.goto(`${A}/api/local/bootstrap/${tok}`);
  await p.waitForLoadState("networkidle").catch(() => {});
  await p.waitForTimeout(1200);
  await p.goto(`${A}/`);
  await p.waitForLoadState("networkidle").catch(() => {});
  await p.waitForTimeout(700);
  OWNER = p.locator(".avatar-field").nth(0);
  AI = p.locator(".avatar-field").nth(1);
  const aiImg = AI.locator(".avatar-preview img");
  const ownerImg = OWNER.locator(".avatar-preview img");

  // ── ① 表单形状：内置四选一没了，AI 头像改成一个上传入口 ───────────────────────
  const fields = await p.locator(".avatar-field").count();
  check("页面上有两个头像区（01 身份 + 02 假 AI）", fields === 2, `实际 ${fields} 个`);
  const aiText = (await AI.innerText()).replace(/\s+/g, " ");
  check("02 段那个「没上传时的内置头像」下拉已经删掉",
    (await AI.locator("select").count()) === 0 && !aiText.includes("圆脸机器人"));
  check("AI 头像区写明了默认是哪张 + 三种进法",
    ["默认", "⌘V", "拖进"].every((t) => aiText.includes(t)), aiText.slice(0, 52));

  const aiSrc0 = await waitSrc(aiImg, (v) => typeof v === "string" && v.length > 0);
  check("没上传时预览就是打包进来的默认图，且走 /assets/（B 的静态白名单只认它）",
    ASSET_URL_RE.test(String(aiSrc0)), String(aiSrc0));
  const def = await aiImg.evaluate((el) => [el.naturalWidth, el.complete]).catch(() => [0, false]);
  check("默认图真取到了（不是破图；根路径那版就死在这里）", def[0] > 0 && def[1] === true,
    `naturalWidth=${def[0]}`);

  // ── ②③ 粘贴 + 仲裁：碰过哪个圈，图进哪个 ──────────────────────────────────────
  TRACE("②③ 粘贴仲裁（碰过哪个归哪个）");
  const redPng = await makePng(p, "#c0392b");
  const ownerSrcBefore = await ownerImg.getAttribute("src").catch(() => null);
  await AI.locator(".avatar-preview").hover();
  const prevented = await paste(p, redPng, "items");
  const aiSrc1 = await waitSrc(aiImg, (v) => String(v).startsWith("data:image/"));
  const ownerSrcAfter = await ownerImg.getAttribute("src").catch(() => null);
  check("粘贴被吃掉了（preventDefault）", prevented === true);
  check("碰过 AI 圈之后，粘贴只改 AI 那张", String(aiSrc1).startsWith("data:image/"),
    `内联 ${String(aiSrc1).length} 字符`);
  check("同一张图没有把 A 自己的脸也换掉", ownerSrcAfter === ownerSrcBefore,
    `${String(ownerSrcBefore).slice(0, 14)} → ${String(ownerSrcAfter).slice(0, 14)}`);
  check("上传图字符数在会话载荷里撑得住（它每遍都要跟着 JSON 走）",
    String(aiSrc1).length < MAX_DATA_URL_CHARS,
    `${String(aiSrc1).length} < ${MAX_DATA_URL_CHARS}`);

  const dims = await aiImg.evaluate((el) => [el.naturalWidth, el.naturalHeight]);
  check("AI 档压到 160×160 正方形（不是 256，也不是原图 300×200）",
    dims[0] === 160 && dims[1] === 160, dims.join("×"));

  const bluePng = await makePng(p, "#2980b9");
  await OWNER.locator(".avatar-preview").hover();
  await paste(p, bluePng, "files");
  const ownerSrcNow = await waitSrc(ownerImg, (v) => String(v).startsWith("data:image/"));
  check("碰过身份圈之后，同一手势的粘贴改的是身份那张", String(ownerSrcNow).startsWith("data:image/"),
    `内联 ${String(ownerSrcNow).length} 字符`);
  const aiStill = await aiImg.getAttribute("src");
  check("AI 那张没被后一次粘贴带走", aiStill === aiSrc1);
  const ownerDims = await ownerImg.evaluate((el) => [el.naturalWidth, el.naturalHeight]);
  check("身份档仍是 256×256（两档边长各管各的，没互相带跑）",
    ownerDims[0] === 256 && ownerDims[1] === 256, ownerDims.join("×"));

  check("上传后出现「用回默认头像」", (await AI.locator('button:has-text("用回默认头像")').count()) === 1);
  await AI.locator('button:has-text("用回默认头像")').click();
  check("点「用回默认头像」立刻退回默认图",
    ASSET_URL_RE.test(String(await waitSrc(aiImg, (v) => ASSET_URL_RE.test(String(v))))), "");
  const buf = Buffer.from(redPng.split(",")[1], "base64");
  await AI.locator('input[type="file"]').setInputFiles({ name: "pick.png", mimeType: "image/png", buffer: buf });
  const aiSrc2 = await waitSrc(aiImg, (v) => String(v).startsWith("data:image/"));
  check("选文件通路也能换 AI 头像", String(aiSrc2).startsWith("data:image/"), `长度 ${String(aiSrc2).length}`);

  // ── ④ 建会话 → B 端的脸（全程走界面，不抄近路打接口）────────────────────────────
  TRACE("④ 建一条带上传头像的会话");
  await p.locator('input[placeholder="小李"]').fill("小李");
  const [res1] = await Promise.all([
    p.waitForResponse((r) => r.url().endsWith("/api/local/sessions") && r.status() === 201),
    p.locator('button:has-text("创建对话链接")').click(),
  ]);
  const id1 = ((await res1.json()).session || {}).id;
  check("会话建出来了（A 送出去的载荷里带着那张图）", !!id1, String(id1).slice(0, 12));

  const bp = await (await br.newContext({ viewport: { width: 420, height: 900 } })).newPage();
  const bErrs = [];
  bp.on("pageerror", (e) => bErrs.push("未捕获异常: " + e.message));
  const defReq1 = [];
  bp.on("response", (r) => { if (ASSET_URL_RE.test(new URL(r.url()).pathname)) defReq1.push(r); });
  await bp.goto(`${B}/s/${id1}`);
  await bp.waitForTimeout(1800);
  const bSrc = await bp.locator(".chat-header .avatar-img").getAttribute("src");
  check("B 端顶上那张脸 = A 上传的图", String(bSrc).startsWith("data:image/"), String(bSrc).slice(0, 24));
  const box = await bp.locator(".chat-header .avatar-img").evaluate((el) => [
    Math.round(el.getBoundingClientRect().width), el.naturalWidth,
  ]);
  check("B 端按 42px 画它（图本身 160，Retina 有余量）", box[0] === 42 && box[1] === 160, box.join("/"));
  check("带上传图时不该去请求默认图（省一次下载）", defReq1.length === 0, `请求 ${defReq1.length} 次`);

  TRACE("④b 再建一条不上传的会话，看默认图与缓存头");
  await p.goto(`${A}/`);
  await p.waitForTimeout(700);
  OWNER = p.locator(".avatar-field").nth(0);
  AI = p.locator(".avatar-field").nth(1);
  check("新表单的 AI 头像是空的（回到默认图）",
    ASSET_URL_RE.test(String(await AI.locator(".avatar-preview img").getAttribute("src"))), "");
  await p.locator('input[placeholder="小李"]').fill("小李");
  const [res2] = await Promise.all([
    p.waitForResponse((r) => r.url().endsWith("/api/local/sessions") && r.status() === 201),
    p.locator('button:has-text("创建对话链接")').click(),
  ]);
  const id2 = ((await res2.json()).session || {}).id;

  const bp2 = await (await br.newContext({ viewport: { width: 420, height: 900 } })).newPage();
  const defReq2 = [];
  bp2.on("response", (r) => { if (ASSET_URL_RE.test(new URL(r.url()).pathname)) defReq2.push(r); });
  await bp2.goto(`${B}/s/${id2}`);
  await bp2.waitForTimeout(1800);
  const bSrc2 = await bp2.locator(".chat-header .avatar-img").getAttribute("src");
  check("没上传时 B 端画默认图", ASSET_URL_RE.test(String(bSrc2)), String(bSrc2));
  const r2 = defReq2[0];
  const h2 = r2 ? r2.headers() : {};
  check("默认图从 /assets/ 出得去：200 + image/jpeg", !!r2 && r2.status() === 200 && String(h2["content-type"]).includes("image/jpeg"),
    r2 ? `${r2.status()} ${h2["content-type"]}` : "压根没发出这个请求");
  check("而且带一年 immutable 缓存（第二次打开这张图零字节）",
    /max-age=31536000/.test(String(h2["cache-control"])) && /immutable/.test(String(h2["cache-control"])),
    String(h2["cache-control"] || "（没有这个头）"));
  const box2 = await bp2.locator(".chat-header .avatar-img").evaluate((el) => [
    Math.round(el.getBoundingClientRect().width), el.naturalWidth,
  ]);
  check("默认图在 B 端也按 42px 画、原图 256 有余量", box2[0] === 42 && box2[1] === 256, box2.join("/"));
  check("默认图没把 A 的会话 JSON 撑肥：预览载荷里 avatarData 是空串",
    !String(bSrc2).startsWith("data:"), "");

  check("A 页面没有未捕获异常", errs.length === 0, errs.join(" | "));
  check("B 页面没有未捕获异常", bErrs.length === 0, bErrs.join(" | "));

  await br.close();
} catch (e) {
  bad.push("探针本身炸了: " + e.message);
} finally {
  child.kill("SIGTERM");
  for (const s of ["", "-shm", "-wal"]) fs.rmSync(dbPath + s, { force: true });
}

for (const l of ok) console.log("✅ " + l);
for (const l of bad) console.log("❌ " + l);
console.log(bad.length ? `\n⚠️ ${bad.length} 条不过（共 ${ok.length + bad.length} 条）` : `\n✅ AI 头像全链路：全过（${ok.length} 条）`);
process.exit(bad.length ? 1 : 0);

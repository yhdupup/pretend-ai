// 归档探针（不是交付物）：真浏览器验「A 的身份头像」三种进法（选文件 / ⌘V 粘贴 / 拖进来），
// 以及两条边界：粘贴时焦点在输入框里不许抢；揭晓之前 B 侧一个 base64 都看不到。
// 自己起一次性实例 + 临时库，绝不动用户那台 8787。跑法：cp 到 coding/ 下 → node tmp-avatar.mjs
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { chromium } from "playwright-core";

const CODING = process.cwd();
const LP = 8897, PP = 8898;
const tok = crypto.randomBytes(32).toString("hex");
const dbPath = path.join(CODING, "data", "tmp-avatar.sqlite");
for (const s of ["", "-shm", "-wal"]) fs.rmSync(dbPath + s, { force: true });
const A = `http://127.0.0.1:${LP}`, B = `http://127.0.0.1:${PP}`;
const EXE = "/Users/a1234/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const TRACE = (m) => console.log("· " + m);
const ok = [];
const bad = [];
const check = (name, pass, detail = "") =>
  (pass ? ok : bad).push(`${name}${detail ? " — " + detail : ""}`);

const child = spawn(path.join(path.dirname(process.execPath), "node"),
  [path.join(CODING, "dist", "server", "index.js")], {
    cwd: CODING, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "production",
      LOCAL_PORT: String(LP), PUBLIC_PORT: String(PP),
      HOST: "127.0.0.1", PUBLIC_HOST: "127.0.0.1",
      LOCAL_DATA_PATH: dbPath, TUNNEL_AUTOSTART: "false",
      LOCAL_CONTROL_TOKEN_SECRET: tok, AIWINDOW_LAUNCHER_TOKEN: "1" } });
child.stdout.on("data", (c) => process.stdout.write(String(c).replace(tok, "<令牌>")));
child.stderr.on("data", (c) => process.stderr.write(String(c).replace(tok, "<令牌>")));

const api = (p, o) => fetch(`${A}${p}`, {
  headers: { cookie: `aiwindow_ctrl=${tok}`, "content-type": "application/json",
    origin: A, "sec-fetch-site": "same-origin", ...(o?.headers ?? {}) }, ...o });
async function up() {
  for (let i = 0; i < 60; i++) {
    try { if ((await api("/api/local/health")).ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// 在页面里画一张 300×200 的实色图并拿到它的字节：既有真实文件，又不依赖仓库里的二进制素材。
const makePng = (page) => page.evaluate(() => {
  const c = document.createElement("canvas");
  c.width = 300; c.height = 200;
  const x = c.getContext("2d");
  x.fillStyle = "#c0392b"; x.fillRect(0, 0, 300, 200);
  return c.toDataURL("image/png");
});

try {
  if (!(await up())) throw new Error("服务没起来");
  const br = await chromium.launch({ executablePath: EXE, args: ["--no-proxy-server"] });
  const ctx = await br.newContext({ viewport: { width: 1180, height: 900 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push("未捕获异常: " + e.message));

  TRACE("bootstrap 解锁 → 首页");
  await p.goto(`${A}/api/local/bootstrap/${tok}`);
  await p.waitForTimeout(800);
  await p.goto(`${A}/`);
  await p.waitForTimeout(600);

  // 2026-09-13 起首页有**两个**头像区：nth=0 是「揭晓时的你」（本脚本的主角），nth=1 是假 AI 的。
  // 所有选择器因此必须落在 OWNER_FIELD 里面 —— 裸 .avatar-preview img 会同时命中
  // 假 AI 那张（它默认就带一张打包图），Playwright 严格模式当场报「多匹配」。
  const OWNER_FIELD = p.locator(".avatar-field").nth(0);
  check("两个头像区都在（01 身份 + 02 假 AI）", (await p.locator(".avatar-field").count()) === 2);
  const fieldText = (await OWNER_FIELD.innerText()).replace(/\s+/g, " ");
  check("提示里三种进法都写到",
    ["上传自己的照片", "⌘V", "拖进"].every((t) => fieldText.includes(t)),
    fieldText.slice(0, 90));

  const png = await makePng(p);
  const pngBuf = Buffer.from(png.split(",")[1], "base64");

  // ① 粘贴（只走 items，模拟「从微信/网页复制一张图」：files 是空的）
  const paste = (via, b64) => p.evaluate(([b64, mode]) => {
    const bin = atob(b64.split(",")[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], "paste.png", { type: "image/png" });
    const dt = new DataTransfer();
    if (mode === "files") dt.items.add(file); // 构造出来的 DataTransfer，files 由 items 喂
    else {
      // 有些浏览器 clipboardData.files 为空、只在 items 里：这里显式做个只给 items 的对象
      Object.defineProperty(dt, "files", { value: [] });
      dt.items.add(file);
    }
    const ev = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt });
    document.body.dispatchEvent(ev);
    return ev.defaultPrevented;
  }, [b64, via]);

  TRACE("① 粘贴（items 路径）");
  const prevented = await paste("items", png);
  await p.waitForTimeout(900);
  const src1 = await OWNER_FIELD.locator(".avatar-preview img").getAttribute("src").catch(() => null);
  check("粘贴被消费掉了（preventDefault）", prevented === true);
  check("预览换成了上传的那张图", !!src1?.startsWith("data:image/"), String(src1).slice(0, 30));
  const dims = await OWNER_FIELD.locator(".avatar-preview img").evaluate((el) => [el.naturalWidth, el.naturalHeight]);
  check("浏览器端已压成正方形 256", dims[0] === 256 && dims[1] === 256, dims.join("×"));

  // ② 焦点在输入框里时，粘贴属于那个输入框：头像不许被抢改
  TRACE("② 焦点在「称呼」输入框里再粘贴");
  const srcBefore = src1;
  await p.locator('input[placeholder="小李"]').click();
  await paste("items", png);
  await p.waitForTimeout(700);
  const src2 = await OWNER_FIELD.locator(".avatar-preview img").getAttribute("src");
  check("输入框里的粘贴没抢走头像", src2 === srcBefore);

  // ②b 粘贴的另一条通路：clipboardData.files 有货（从 Finder 复制文件就是这个样子）
  TRACE("②b 粘贴（files 路径，换一张蓝色图）");
  const pngBlue = await p.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 60; c.height = 60;
    const x = c.getContext("2d");
    x.fillStyle = "#2980b9"; x.fillRect(0, 0, 60, 60);
    return c.toDataURL("image/png");
  });
  await paste("files", pngBlue);
  await p.waitForTimeout(900);
  const src3 = await OWNER_FIELD.locator(".avatar-preview img").getAttribute("src");
  check("files 通路也能换头像", !!src3 && src3 !== srcBefore, `长度 ${src3?.length}`);

  // ③ 选文件（input[type=file] 的 change 通路）
  TRACE("③ setInputFiles 走文件选择");
  await OWNER_FIELD.locator('input[type="file"]').setInputFiles({ name: "pick.png", mimeType: "image/png", buffer: pngBuf });
  await p.waitForTimeout(900);
  check("选文件也能换上头像", (await OWNER_FIELD.locator(".avatar-preview img").count()) === 1);
  check("出现了「用回内置头像」", await p.locator("button", { hasText: "用回内置头像" }).count() === 1);

  // ④ 存到服务端：点「创建新会话」会把身份先 PUT 再建会话
  TRACE("④ 建会话 → 看头像有没有真的落库并快照");
  await p.fill('input[placeholder="小李"]', "头像验收");
  await p.locator("button", { hasText: "创建对话链接" }).click();
  await p.waitForTimeout(1500);
  const profile = await (await api("/api/local/settings")).json();
  check("设置里存下了这张图", String(profile.profile.ownerAvatarData).startsWith("data:image/"),
    `长度 ${String(profile.profile.ownerAvatarData).length}`);
  // 会话 id 从地址栏拿：创建成功后前端会 navigate(`/sessions/{id}`)。
  // （没有 GET /api/local/sessions 这个列表路由，之前想当然了。）
  const sessionId = /\/sessions\/([0-9a-f-]{8,})/.exec(p.url())?.[1] ?? null;
  check("建完会话跳到了会话页并拿到 id", !!sessionId, String(sessionId).slice(0, 8));

  // ⑤ 揭晓之前，B 侧一个字节的图都看不到（预览路由 + 页面 HTML 一起看）
  const previewBody = await (await fetch(`${B}/api/public/sessions/${sessionId}/preview`)).text();
  check("揭晓前 preview 里没有图", !previewBody.includes("data:image"));
  const bctx = await br.newContext();
  const bp = await bctx.newPage();
  await bp.goto(`${B}/s/${sessionId}`);
  await bp.waitForTimeout(900);
  // B 要先点「开始对话」把链接绑掉（/preview 路由故意不绑），否则永远停在预览页，
  // 揭晓压根不出现 —— 上一轮就是因为漏了这一步，把功能误判成坏了。
  const claimCookie = async () =>
    // 不带 URL 参数：绑定凭据的 cookie 是 path 作用域到 /s/<id> 的，
    // 用 cookies(url) 按根路径过滤会把它筛掉 → 我这边就一直是 404（假故障）。
    (await bctx.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  // 按钮文案在两轮回界面调整里从「开始对话」变成了「进入对话 →」：归档脚本跟着改口
  await bp.locator('button', { hasText: '进入对话' }).click();
  await bp.waitForTimeout(1200);
  const bImgSrcs = await bp
    .locator("img")
    .evaluateAll((els) => els.map((e) => e.getAttribute("src") ?? ""));
  check("揭晓前 B 顶上有假 AI 的默认图（这是 2026-09-13 起的正常现象）",
    bImgSrcs.some((x) => /^\/assets\/ai-avatar-/.test(x)),
    bImgSrcs.join(",").slice(0, 46));
  check("揭晓前 B 页面上没有 A 上传的那张 data 图",
    !bImgSrcs.some((x) => x.startsWith("data:image/")),
    bImgSrcs.filter((x) => x.startsWith("data:")).length + " 张");
  const preBody = await (
    await fetch(`${B}/api/public/sessions/${sessionId}/poll`, {
      headers: { cookie: await claimCookie() },
    })
  ).text();
  check(
    "揭晓前 poll 载荷里一个图字节都没有",
    !preBody.includes("data:image"),
    `reveal=${/"reveal":(null|\{)/.exec(preBody)?.[1]}`,
  );

  // ⑥ 揭晓 → B 的揭晓卡片上就是这张脸
  const rev = await api(`/api/local/sessions/${sessionId}/reveal`, {
    method: "POST",
  });
  console.log("  [reveal]", rev.status, (await rev.text()).slice(0, 60));
  await bp.goto(`${B}/s/${sessionId}`);
  await bp.waitForTimeout(1500);
  const revealed = await bp
    .locator(".reveal-popup .avatar-img")
    .getAttribute("src")
    .catch(() => null);
  console.log(
    "  [B 页面文字]",
    (await bp.evaluate(() => document.body.innerText)).replace(/\s+/g, " ").slice(0, 120),
  );
  check(
    "揭晓后 B 看到 A 上传的头像",
    String(revealed).startsWith("data:image/"),
    `${String(revealed).slice(0, 24)}…`,
  );
  const revealedDims = revealed
    ? await bp
        .locator(".reveal-popup .avatar-img")
        .evaluate((el) => [el.naturalWidth, el.clientWidth])
        .catch(() => null)
    : null;
  check("那张图真的绘制出来了（不是破图）", !!revealedDims && revealedDims[0] === 256, JSON.stringify(revealedDims));
  const pollBody = await (
    await fetch(`${B}/api/public/sessions/${sessionId}/poll`, {
      headers: { cookie: await claimCookie() },
    })
  ).text();
  console.log("  [poll 原文]", pollBody.slice(0, 200));
  const getBody = await (
    await fetch(`${B}/api/public/sessions/${sessionId}`, {
      headers: { cookie: await claimCookie() },
    })
  ).text();
  check(
    "揭晓后载荷里 avatarData 带上了图",
    getBody.includes('avatarData":"data:image'),
    `poll=${pollBody.slice(0, 40)} | GET /:id reveal 有 avatarData=${getBody.includes("avatarData")}`,
  );

  check("全程没有未捕获异常", errs.length === 0, errs.join(" / "));
  await br.close();
} finally {
  child.kill("SIGTERM");
  for (const s of ["", "-shm", "-wal"]) fs.rmSync(dbPath + s, { force: true });
}

console.log(`\n✅ ${ok.length} 项通过`);
for (const t of ok) console.log("   · " + t);
if (bad.length) { console.log(`\n❌ ${bad.length} 项失败`); for (const t of bad) console.log("   · " + t); }
process.exit(bad.length ? 1 : 0);

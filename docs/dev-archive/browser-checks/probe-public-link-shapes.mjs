// 临时（跑完删）：另起一个测试实例，把「另一台电脑打开公网链接」可能遇到的几种形状全跑一遍，
// 看哪一种会给出 404。用法：cd coding && node tmp-public-probe.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";

const CODING = process.cwd();
const LP = 8897, PP = 8898;
const tok = crypto.randomBytes(32).toString("hex");
const dbPath = path.join(CODING, "data", "tmp-probe.sqlite");
for (const s of ["", "-shm", "-wal"]) fs.rmSync(dbPath + s, { force: true });

// 与产品同一条公网路径：跟随系统代理，回环不走（env-proxy 模块在 import 时就生效）
process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1", "localhost", "::1"].filter(Boolean).join(",");
const { proxyProbeMode } = await import("./dist/server/net/env-proxy.js");
console.log("   本脚本公网探活口径：" + JSON.stringify(proxyProbeMode()));
process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1", "localhost", "::1"].filter(Boolean).join(",");

const child = spawn(
  path.join(path.dirname(process.execPath), "node"),
  [path.join(CODING, "dist", "server", "index.js")],
  {
    cwd: CODING,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NODE_ENV: "production",
      LOCAL_PORT: String(LP), PUBLIC_PORT: String(PP),
      HOST: "127.0.0.1", PUBLIC_HOST: "0.0.0.0",
      LOCAL_DATA_PATH: dbPath,
      TUNNEL_AUTOSTART: "true", TUNNEL_MODE: "auto", TUNNEL_CLIENT_PATH: "bin/cloudflared",
      LOCAL_CONTROL_TOKEN_SECRET: tok, AIWINDOW_LAUNCHER_TOKEN: "1",
    },
  },
);
child.stdout.on("data", (c) => process.stdout.write(String(c).replace(tok, "<令牌>")));
child.stderr.on("data", (c) => process.stderr.write(String(c)));
const P = (p, o) => fetch(`http://127.0.0.1:${LP}${p}`, {
  headers: { cookie: `aiwindow_ctrl=${tok}`, ...(o?.headers ?? {}) },
  method: o?.method ?? "GET", body: o?.body,
  ...(o?.body ? { duplex: "half" } : {}),
});

async function pub(url) {
  // 用全局 fetch：它已经被 env-proxy 绑到系统代理（和产品探活同一条路）
  const t0 = Date.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(25_000), redirect: "manual" });
    const body = await r.text();
    return {
      code: r.status, size: body.length, ms: Date.now() - t0,
      head: body.replace(/\s+/g, " ").slice(0, 110),
      loc: r.headers.get("location") ?? "",
    };
  } catch (e) {
    return { code: "ERR", err: String(e?.cause?.code ?? e?.message ?? e).slice(0, 80), size: 0, head: "", ms: Date.now() - t0 };
  }
}

const show = (label, r) =>
  console.log(`  ${String(label).padEnd(38)} → HTTP ${String(r.code).padEnd(5)} ${(r.size ?? 0).toString().padStart(6)}B ${((r.ms ?? 0) / 1000).toFixed(1)}s  ${r.err ? "‹" + r.err + "›" : "‹" + r.head + "›"}`);

try {
  // 等隧道给地址
  let t = null;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const j = await (await P("/api/local/status")).json();
    t = j.tunnel;
    if (t?.publicBaseUrl || t?.pendingBaseUrl) break;
  }
  let base = t?.publicBaseUrl || t?.pendingBaseUrl;
  base = (await (await P("/api/local/status")).json()).tunnel?.publicBaseUrl ?? base;
  console.log("\n隧道地址:", base ?? "(没有)");
  if (!base) throw new Error("没拿到公网地址，实验做不了");

  // 等本机验通（没验通时接口会退回 127.0.0.1 地址，那正是「发出去别人打不开」的那个形状）
  for (let i = 0; i < 30; i++) {
    const j = await (await P("/api/local/status")).json();
    if (j.tunnel?.reachable && j.tunnel?.publicBaseUrl) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  const cr = await P("/api/local/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: `http://127.0.0.1:${LP}`, "sec-fetch-site": "same-origin" },
    body: JSON.stringify({ mode: "rules" }),
  });
  const s = await cr.json();
  console.log("建会话 HTTP", cr.status, " publicUrlSource =", s.publicUrlSource);
  const link = s.publicUrl;
  console.log("新建会话链接:", link.replace(base, "<基址>"));

  console.log("\n== 另一台电脑可能出现的六种形状 ==");
  show("① 完整链接（刚建的）", await pub(link));
  show("② 只打开基址（漏了 /s/…）", await pub(base + "/"));
  const fake = base + "/s/" + crypto.randomUUID();
  show("③ 基址对、id 是别处的", await pub(fake));
  show("④ 把 https 打成 http", await pub(link.replace("https://", "http://")));
  show("⑤ 复制时带上了后面中文括号的尾巴", await pub(link + "）"));
  console.log("\n  （对照：这一台机器直连、不经代理）");
  show("⑥ 完整链接（重复一次，看稳定性）", await pub(link));

  console.log("\n== 停掉这个实例之后，同一条链接（=旧域名）==");
  child.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 4000));
  show("⑦ 实例已停，链接还在别人手里", await pub(link));
} finally {
  try { child.kill("SIGKILL"); } catch {}
  for (const s of ["", "-shm", "-wal"]) { try { fs.rmSync(dbPath + s); } catch {} }
  console.log("\n测试实例已停，临时库已删");
}

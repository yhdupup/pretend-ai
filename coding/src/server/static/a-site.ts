import fs from "node:fs";
import path from "node:path";
import type { Context } from "hono";

// 阶段5：A 工作台由本机控制入口自己发（PRD §6.1 第 7~9 步、§12.2 第 14~18 步）。
//
// 为什么必须有这个文件：B 端在阶段3 就能由公开入口发页面，A 端一直只能靠 Vite dev server。
// 双击启动的场景里没有 Vite —— 「自动打开 A 工作台」这一步压根没有可打开的东西。
// A 前端全部用相对路径请求 /api/local/*，同源化之后不需要 proxy、不需要 CORS，前端零改动。
//
// 安全边界（与 b-site 同一套，但更紧）：
// - 这个 app 只挂在 A 入口（默认 127.0.0.1），监听面已经保证不出本机；
// - 只认三类路径：/ 、/bootstrap/*、/sessions/*（前端手写路由的三个形态）与 /assets/*（构建产物）；
// - /assets/* 走与 B 端同一套 safeJoin：既拒绝字面 ..，又校验解析后的绝对路径仍在 dist 内；
// - 页面壳（index.html 与 assets）本身不含任何会话数据，所以在鉴权中间件里被免 Cookie
//   —— 但 Host/Origin 校验照旧生效，本机外的域名指向 127.0.0.1 也拿不到（PRD §18.1）。

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/** A 前端没构建时给本机看的提示页（不能让工作台打开一个空白 200，会以为程序坏了）。 */
const MISSING_BUILD_PAGE =
  `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>A 工作台未构建</title>` +
  `<p style="font:14px/1.6 system-ui;padding:24px">A 工作台页面还没有构建。` +
  `用启动脚本跑一次会自动构建；手工启动则在 <code>coding/</code> 下执行 ` +
  `<code>npm run build -w apps/a-frontend</code> 后刷新。</p></html>`;

function safeJoin(root: string, rel: string): string | null {
  if (rel.includes("\0") || rel.includes("\\")) return null;
  const target = path.resolve(root, "." + path.posix.normalize("/" + rel));
  const resolvedRoot = path.resolve(root);
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep))
    return null;
  return target;
}

export interface ASite {
  root: string;
  distExists: () => boolean;
  /** GET / 与前端手写路由（/bootstrap/*、/sessions/*）：永远返回同一份 index.html。 */
  entry(c: Context): Response | Promise<Response>;
  /** GET /assets/*：只服务构建产物。 */
  asset(c: Context): Response | Promise<Response>;
}

export function createASite(distPath: string): ASite {
  const root = path.resolve(distPath);
  const indexFile = path.join(root, "index.html");
  // dist 是构建产物，可能在启动之后才出现（首次启动边构建边等着），所以每次现查不缓存。
  const distExists = () => fs.existsSync(indexFile);

  return {
    root,
    distExists,
    entry(c) {
      if (!distExists()) {
        return c.html(MISSING_BUILD_PAGE, 503, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
      }
      return c.html(fs.readFileSync(indexFile, "utf8"), 200, {
        // 工作台入口不缓存：改了代码刷新就生效，也是 CSP 与 Cookie 语义最省事的做法。
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      });
    },
    asset(c) {
      const rel = c.req.path.replace(/^\/assets\//, "");
      const file = safeJoin(root, path.join("assets", rel));
      if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile())
        return c.notFound();
      const ext = path.extname(file).toLowerCase();
      const type = MIME[ext];
      if (!type) return c.notFound();
      return c.body(fs.readFileSync(file) as unknown as ArrayBuffer, 200, {
        "content-type": type,
        // Vite 产物文件名带 hash，可以长缓存；index.html 那侧是 no-store，两者不冲突。
        "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      });
    },
  };
}

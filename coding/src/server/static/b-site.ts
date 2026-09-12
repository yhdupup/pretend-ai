import fs from "node:fs";
import path from "node:path";
import type { Context } from "hono";

// 阶段3：B 公开入口自带的静态页面。
//
// 为什么必须在这里发页面：隧道指向的是 B 公开端口，如果它只能返回 JSON，B 拿到的链接就打开不了网页。
// 所以打包/公网模式下由这个进程发 apps/b-frontend/dist（开发模式仍走 Vite dev server，两边行为一致）。
//
// 安全边界：只认两条路径 —— /s/<会话id>（永远返回同一份 index.html，不因 id 未知而给出不同响应）
// 和 /assets/<文件名>（只允许构建产物里的 js/css/图片/字体）。其余路径一律由白名单中间件返回统一 404。
// A 工作台、本机设置、Skill 文件、源码都不在这个 root 里，也不可能有路径能走到。

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
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

// 前端没构建时给 A 看的提示页（不能让公网页面返回一个空白 200，会以为服务挂了）
const MISSING_BUILD_PAGE =
  `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>页面未构建</title>` +
  `<p style="font:14px/1.6 system-ui">B 端页面还没有构建。在 A 的电脑上执行 <code>npm run build -w apps/b-frontend</code> 后刷新。</p></html>`;

function safeJoin(root: string, rel: string): string | null {
  // 双保险：既拒绝字面 ..，又校验解析后的绝对路径确实落在 root 内（防编码绕过、软链出逃）
  if (rel.includes("\0") || rel.includes("\\")) return null;
  const target = path.resolve(root, "." + path.posix.normalize("/" + rel));
  const resolvedRoot = path.resolve(root);
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep))
    return null;
  return target;
}

async function sendFile(
  c: Context,
  filePath: string,
  immutable: boolean,
): Promise<Response> {
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext];
  if (!type) return c.notFound();
  const body = fs.readFileSync(filePath);
  return c.body(body as unknown as ArrayBuffer, 200, {
    "content-type": type,
    "cache-control": immutable
      ? "public, max-age=31536000, immutable"
      : "no-cache",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
}

export interface BSite {
  /** GET /assets/*：只服务构建产物。dist 不存在时 404。 */
  asset(c: Context): Promise<Response> | Response;
  /** GET /s/:id：SPA 入口。永远返回同一份 index.html。 */
  entry(c: Context): Response;
  distExists: boolean;
  root: string;
}

export function createBSite(distPath: string): BSite {
  const root = path.resolve(distPath);
  const indexFile = path.join(root, "index.html");
  const distExists = fs.existsSync(indexFile);

  let cachedIndex: string | null = null;
  const indexHtml = (): string => {
    if (cachedIndex === null) {
      cachedIndex = fs.existsSync(indexFile)
        ? fs.readFileSync(indexFile, "utf8")
        : MISSING_BUILD_PAGE;
    }
    return cachedIndex;
  };

  return {
    distExists,
    root,
    entry(c) {
      // 未知的会话 id 也返回同一份页面：由 B 前端自己去调 preview 并显示「链接无效」。
      // 这样公网探测者无法通过状态码/响应差异枚举哪些链接真实存在。
      return c.html(indexHtml(), distExists ? 200 : 503, {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      });
    },
    asset(c) {
      const rel = decodeURIComponent(c.req.path.slice("/assets/".length));
      if (!rel || rel.includes("..")) return c.notFound();
      const target = safeJoin(path.join(root, "assets"), rel);
      if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile())
        return c.notFound();
      // Vite 产物带内容哈希，可以放心长缓存
      return sendFile(c, target, true);
    },
  };
}

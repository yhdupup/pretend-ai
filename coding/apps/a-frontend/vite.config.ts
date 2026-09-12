import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// A 前端（本机控制端）独立 Vite 项目。开发态通过 proxy 把 /api/local/* 转发到本机 A 入口，
// 避免浏览器把跨端口请求当跨源请求处理（同 hostname 不同端口即触发 CORS）。
// server.fs.allow 额外放行到 monorepo 根目录，使本项目可以直接引用 ../../src/shared 下的共用类型。
//
// 端口与后端地址都可以用环境变量覆盖（e2e 用 5273/18787 跑，避免撞上正在用的 5173/8787）。
// 注意：A 页面必须用 http://127.0.0.1:<port> 打开，不要用 localhost ——
// 控制会话 Cookie 是绑在 127.0.0.1 这个 host 上的，换 hostname 就没了。

const localApi = process.env.VITE_LOCAL_API_TARGET ?? "http://127.0.0.1:8787";
const port = Number(process.env.A_FRONTEND_DEV_PORT ?? 5173);

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port,
    strictPort: true,
    fs: {
      allow: [".", "../.."],
    },
    proxy: {
      "/api/local": {
        target: localApi,
        changeOrigin: true,
      },
    },
  },
});

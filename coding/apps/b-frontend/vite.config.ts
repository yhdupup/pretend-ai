import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// B 前端（公开访问端）独立 Vite 项目。开发态通过 proxy 把 /api/public/* 转发到
// 0.0.0.0:8788（本机联调时用 127.0.0.1 即可访问），避免跨端口请求被当作跨源请求。

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    fs: {
      allow: [".", "../.."],
    },
    proxy: {
      "/api/public": {
        target: "http://127.0.0.1:8788",
        changeOrigin: true,
      },
    },
  },
});

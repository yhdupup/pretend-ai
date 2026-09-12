import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // 每个测试文件跑之前先隔离数据文件与隧道（见 test/setup.ts）
    setupFiles: ["./test/setup.ts"],
  },
});

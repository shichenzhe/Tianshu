import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src-react"),
      // 共享包（RC-T1 protocol / RC-T3 core）：测试经源码消费（四处
      // alias 登记之一）
      "@tianshu/protocol": path.resolve(
        import.meta.dirname,
        "packages/tianshu-protocol/src",
      ),
      "@tianshu/core": path.resolve(
        import.meta.dirname,
        "packages/tianshu-core/src",
      ),
    },
  },
  // tsconfig 为 jsx: preserve（生产由 @vitejs/plugin-react 转换），vitest 独立
  // 跑且无该插件，需显式启用 JSX 转换才能 import .tsx 组件做静态渲染测试
  // （Vite 8 为 rolldown-vite，转换走 oxc 而非 esbuild，配 esbuild 会被忽略）
  oxc: {
    jsx: { runtime: "automatic" },
  },
  test: {
    // tsx：React 组件交互测试（如 tests/ai/edit-bar.test.tsx，
    // 文件内以 @vitest-environment jsdom 指定 DOM 环境）
    include: ["scripts/**/*.test.mjs", "tests/**/*.test.{mjs,ts,tsx}"],
    // 全局隔离数据根（tests/setup.ts）：防 jwt-secret 等落盘副作用写真实 ~/.tianshu
    setupFiles: ["tests/setup.ts"],
  },
});

// packages 单测归宿（桌面端迁入 apps/tianshu-desktop 后自 desktop
// vitest include 移出）：packages/*/src 内与源码同目录的单测在根源码
// 消费（alias 口径与其余三处登记一致）；include 不写越界 ../.. glob。
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
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
  oxc: {
    jsx: { runtime: "automatic" },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    setupFiles: ["vitest.packages.setup.ts"],
  },
});

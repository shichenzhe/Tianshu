import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // tsx 组件静态测试（usage-chip/image-pick 经组件源链）需要 JSX 转换
  // （node_modules 树更换后 rolldown 缺省不再自动处理 jsx）
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    alias: {
      // nativewind 真身含 RN 语法且对实体位置敏感（本地树/根 hoist 决定
      // 是否被 Node 原生编译），resolver 层钉死到替身——见 stub 头注释
      nativewind$: fileURLToPath(
        new URL("./src/testing/nativewind.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});

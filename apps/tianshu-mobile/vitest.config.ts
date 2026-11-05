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
    // workspace 链接包（@tianshu/*）强制 inline：rolldown 对外置 CJS 的
    // 双通道解析在 vi.mock 隔离图下产生第二实例（新旧 dist 键不一致，
    // 2026-11-05 实证：store 图 upload=undefined 而 entry 图有值）——
    // inline 走 transform 管道保单实例
    server: {
      deps: {
        inline: [/@tianshu\/(protocol|core)/],
      },
    },
  },
});

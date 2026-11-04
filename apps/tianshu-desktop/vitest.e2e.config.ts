// E2E 冒烟专用 vitest 配置（npm run test:e2e:ui）：e2e 脚本文件名无
// .test. 段（e2e-smoke/e2e-graph-smoke 同款约定，不进常规集），而 vitest
// CLI 的文件参数仍受 include 过滤不越界（v4 实测 No test files found），
// 故为本文件独立收口 include；alias/oxc/setupFiles 沿 vitest.config 基座。
// 文件名非 vitest 自动探测名（vitest.config.ts），仅 --config 显式生效，
// 不影响 npm run test 常规集。
import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.ts";

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: ["tests/ai/server/e2e-ui-smoke.ts"],
  },
});

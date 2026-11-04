// relay E2E 专用 vitest 配置（npm run test:e2e:relayE2E）：e2e-relay-e2e
// 文件名无 .test. 段（e2e-smoke/e2e-ui-smoke 同款约定，不进常规集），而
// vitest CLI 的文件参数仍受 include 过滤不越界——为此独立收口 include
// （vitest.e2e.config.ts 同款机制）；alias/oxc/setupFiles 沿 vitest.config
// 基座。文件名非 vitest 自动探测名，仅 --config 显式生效，不影响
// npm run test 常规集与 test:e2e:ui。
import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.ts";

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: ["tests/ai/server/e2e-relay-e2e.ts"],
  },
});

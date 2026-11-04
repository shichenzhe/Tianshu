// 根 lint 只管 packages/* 与根级脚本：桌面端迁 apps/tianshu-desktop 后
// 自带同规则 config；server/mobile 子项目各有独立 lint 体系（server 单引号
// 风格 / mobile RN 规则），误扫必红（CI lint 步骤三平台连坐）。
// 规则层与 apps/tianshu-desktop/eslint.config.js 保持同步（两份同改）。
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig } from "eslint/config";
import prettierConfig from "eslint-config-prettier";
import prettierPlugin from "eslint-plugin-prettier";

export default defineConfig([
  {
    ignores: ["node_modules", "dist", "**/dist", "apps"],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  prettierConfig,
  {
    plugins: { prettier: prettierPlugin },
    rules: {
      "prettier/prettier": "error",
      semi: ["error", "always"],
      quotes: ["error", "double", { avoidEscape: true }],
      // `_` 前缀是本仓「占位不用」惯例（接口形状对齐/mock 签名/解构剔除）
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": process.env.NODE_ENV === "production" ? "warn" : "off",
      "no-debugger": process.env.NODE_ENV === "production" ? "warn" : "off",
    },
  },
]);

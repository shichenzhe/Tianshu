import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig } from "eslint/config";
import prettierConfig from "eslint-config-prettier";
import prettierPlugin from "eslint-plugin-prettier";

export default defineConfig([
  {
    ignores: [
      "node_modules",
      "dist",
      "dist-electron",
      "public",
      "release",
      "electron/infrastructure/prisma",
      "electron/generated",
      // apps/* 子项目各有独立 lint 体系（server 单引号风格 / mobile RN 规则），
      // 根规则只管桌面端与 packages/*，误扫必红（CI lint 步骤三平台连坐）
      "apps",
    ],
  },
  // ESLint 10 flat config: 直接引用 js.configs.recommended 对象，
  // 不再使用 "js/recommended" 字符串 extends（插件需在同一 config 对象内注册）
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

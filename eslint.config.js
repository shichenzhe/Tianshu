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
      "no-console": process.env.NODE_ENV === "production" ? "warn" : "off",
      "no-debugger": process.env.NODE_ENV === "production" ? "warn" : "off",
    },
  },
]);

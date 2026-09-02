import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig } from "eslint/config";
import prettierConfig from "eslint-config-prettier";
import prettierPlugin from "eslint-plugin-prettier";

export default defineConfig([
  prettierConfig,
  {
    ignores: ["node_modules", "dist", "dist-electron", "public", "release", "electron/infrastructure/prisma", "electron/generated"]
  },
  {
    plugins: { prettier: prettierPlugin, js },
    rules: {
      "prettier/prettier": "error",
      "semi": ["error", "always"],
      "quotes": ["error", "double", { "avoidEscape": true }],
      "no-console": process.env.NODE_ENV === "production" ? "warn" : "off",
      "no-debugger": process.env.NODE_ENV === "production" ? "warn" : "off"
    }
  },
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    extends: ["js/recommended"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } }
  },
  tseslint.configs.recommended
]);

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/**/*.test.mjs", "tests/**/*.test.{mjs,ts}"],
  },
});

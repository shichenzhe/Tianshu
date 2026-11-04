import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// 渲染进程禁止裸引 @tianshu/core barrel：barrel 含 e2e-crypto（纯
// node:crypto），经 vite-plugin-electron-renderer 会改写为 require 垫片，
// sandbox 渲染层无 require 直接 ReferenceError（2026-10-18 定时任务页
// 线上报错）。前端消费共享包实现一律走子路径（如
// @tianshu/core/schedule-schema），vite/vitest alias 前缀替换语义与
// tsconfig paths 通配映射均已登记。
const RENDERER_ROOT = path.resolve(import.meta.dirname, "../../src-react");
const BARE_CORE_BARREL = /from\s+["']@tianshu\/core["']/;

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) {
      continue;
    }
    const fullPath = path.join(dir, name);
    if (statSync(fullPath).isDirectory()) {
      collectSourceFiles(fullPath, acc);
    } else if (/\.(ts|tsx)$/.test(name)) {
      acc.push(fullPath);
    }
  }
  return acc;
}

describe("renderer core barrel guard", () => {
  it("src-react 不得裸引 @tianshu/core barrel（须走子路径）", () => {
    const offenders = collectSourceFiles(RENDERER_ROOT).filter((file) =>
      BARE_CORE_BARREL.test(readFileSync(file, "utf8")),
    );
    expect(offenders.map((file) => path.relative(RENDERER_ROOT, file))).toEqual(
      [],
    );
  });
});

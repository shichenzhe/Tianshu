/**
 * Composer 实底按钮 nativewind 铁律守卫：
 * 本仓 nativewind v4 栈实证——className 共存时**函数式 style 内的
 * backgroundColor 会被静默丢弃**（2026-11-06 报障：浅色模式发送键
 * 主色底丢失，白箭头坐在白色输入条上不可见；暗色输入条深底侥幸可见）。
 * 铁律：实色底一律对象式；按压反馈可留函数式（该栈若丢弃仅退化为无
 * 按压态，不伤实底）。本测试静态扫源码，防未来改回函数式实底。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("./Composer.tsx", import.meta.url)),
  "utf8",
);

/** 函数式 style（({ pressed }) => ({ ... })）返回块内的实底声明 */
const FUNCTIONAL_SOLID_BG =
  /\(\{\s*pressed\s*\}\)\s*=>\s*\(\{[^}]*backgroundColor:\s*(?:colors\.primary|STOP_BG)[^}]*\}\)/s;

describe("Composer 实底按钮 nativewind 铁律", () => {
  it("函数式 style 内不得声明主色/中止红实底（该栈静默丢弃 → 白底白箭头）", () => {
    expect(source.match(FUNCTIONAL_SOLID_BG) ?? []).toEqual([]);
  });

  it("发送/中止键实底以对象式 style 存在（按压态由 state 承载）", () => {
    expect(source).toContain("backgroundColor: STOP_BG, opacity:");
    expect(source).toContain("backgroundColor: colors.primary,");
    expect(source).toContain("setActionPressed");
  });
});

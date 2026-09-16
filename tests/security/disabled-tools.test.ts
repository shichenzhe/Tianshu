/** SP6 内置运行时开关：配置白名单清洗 + 注入过滤纯函数（spec §3） */
import { describe, expect, it, vi } from "vitest";

// tool-registry 传递依赖 network-gate → Log（→ electron），经 vi.mock 替换
// （照 tests/ai/command-tool.test.ts 先例）
vi.mock("../../electron/commons/Log", () => ({
  default: { error: vi.fn() },
}));

import {
  BUILTIN_TOOLS,
  SECURITY_DEFAULTS,
} from "../../electron/domains/security/defaults";
import { pickDisabledTools } from "../../electron/domains/security/config-store";
import { filterDisabledTools } from "../../electron/domains/ai/agent/tool-registry";
import type { SecurityConfig } from "../../src-react/domains/security/model/types";

const BUILTIN_NAMES = BUILTIN_TOOLS.map((t) => t.name);

describe("BUILTIN_TOOLS 注册表（spec §3.1）", () => {
  it("13 个内置工具、四组齐全、名字唯一", () => {
    expect(BUILTIN_NAMES).toHaveLength(13);
    expect(new Set(BUILTIN_NAMES).size).toBe(13);
    for (const group of ["file", "command", "skill", "plan"] as const) {
      expect(BUILTIN_TOOLS.some((t) => t.group === group)).toBe(true);
    }
  });
});

describe("pickDisabledTools（白名单清洗）", () => {
  it("只收已知名，去重保注册表序", () => {
    expect(
      pickDisabledTools(["run_command", "nope", "delete_file", "run_command"]),
    ).toEqual(["run_command", "delete_file"]);
  });
  it("非数组/含 mcp__ 前缀一律回落空或剔除", () => {
    expect(pickDisabledTools(undefined)).toEqual([]);
    expect(pickDisabledTools("run_command")).toEqual([]);
    expect(pickDisabledTools(["mcp__x__y"])).toEqual([]);
  });
});

describe("filterDisabledTools（注入过滤）", () => {
  const defs = [
    { name: "read_file" },
    { name: "read_skill" },
    { name: "mcp__srv__tool" },
  ];
  it("禁用名剔除；mcp__ 不在白名单天然不受影响", () => {
    expect(filterDisabledTools(defs, ["read_file"])).toEqual([
      { name: "read_skill" },
      { name: "mcp__srv__tool" },
    ]);
  });
  it("空禁用集原样返回", () => {
    expect(filterDisabledTools(defs, [])).toEqual(defs);
  });
});

describe("defaults 演进（SP6）", () => {
  it("SECURITY_DEFAULTS.disabledTools 为空数组（全启用零行为变化）", () => {
    const config = SECURITY_DEFAULTS as SecurityConfig;
    expect(config.disabledTools).toEqual([]);
  });
});

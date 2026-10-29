/** SP6 内置运行时开关：配置白名单清洗 + 注入过滤纯函数（spec §3） */
import { describe, expect, it, vi } from "vitest";

// tool-registry 传递依赖 network-gate → Log（→ electron），经 vi.mock 替换
// （照 tests/ai/command-tool.test.ts 先例）
vi.mock("../../electron/commons/Log", () => ({
  default: { error: vi.fn() },
}));
// automation collectTools 直测（SP6 裁定 2）需拉起 automation-runner 模块图：
// prisma-client（加载即建库目录）/electron/chat.service 三件套照
// tests/ai/automation-runner.test.ts 先例 mock（断言不涉及，零行为介入）
vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => `/tmp/tianshu-test-user-data-${process.pid}`) },
}));
vi.mock("../../electron/commons/prisma-client", () => ({
  default: {},
}));
vi.mock("../../electron/domains/ai/chat/chat.service", () => ({
  runChatStream: vi.fn(),
}));

import {
  BUILTIN_TOOLS,
  SECURITY_DEFAULTS,
} from "../../electron/domains/security/defaults";
import { pickDisabledTools } from "../../electron/domains/security/config-store";
import { filterDisabledTools } from "../../electron/domains/ai/agent/tool-registry";
import { collectTools } from "../../electron/domains/ai/automation/automation-runner";
import type { SecurityConfig } from "../../src-react/domains/security/model/types";

const BUILTIN_NAMES = BUILTIN_TOOLS.map((t) => t.name);

describe("BUILTIN_TOOLS 注册表（spec §3.1）", () => {
  it("17 个内置工具、五组齐全、名字唯一", () => {
    expect(BUILTIN_NAMES).toHaveLength(17);
    expect(new Set(BUILTIN_NAMES).size).toBe(17);
    for (const group of [
      "file",
      "command",
      "skill",
      "expert",
      "plan",
    ] as const) {
      expect(BUILTIN_TOOLS.some((t) => t.group === group)).toBe(true);
    }
  });
});

describe("pickDisabledTools（白名单清洗）", () => {
  it("只收已知名，去重保注册表序", () => {
    expect(
      pickDisabledTools(["bash", "nope", "rm", "bash"]),
    ).toEqual(["bash", "rm"]);
  });
  it("非数组/含 mcp__ 前缀一律回落空或剔除", () => {
    expect(pickDisabledTools(undefined)).toEqual([]);
    expect(pickDisabledTools("bash")).toEqual([]);
    expect(pickDisabledTools(["mcp__x__y"])).toEqual([]);
  });
});

describe("filterDisabledTools（注入过滤）", () => {
  const defs = [
    { name: "read" },
    { name: "read_skill" },
    { name: "mcp__srv__tool" },
  ];
  it("禁用名剔除；mcp__ 不在白名单天然不受影响", () => {
    expect(filterDisabledTools(defs, ["read"])).toEqual([
      { name: "read_skill" },
      { name: "mcp__srv__tool" },
    ]);
  });
  it("空禁用集原样返回", () => {
    expect(filterDisabledTools(defs, [])).toEqual(defs);
  });
});

// chat 侧 collectToolDefinitions 为 private 方法不直测：其过滤逻辑与
// automation 同构一行（filterDisabledTools 包尾），由 Task 6 手工验收清单
// 端到端覆盖（SP6 裁定 2）
describe("automation collectTools 注入过滤（SP6 裁定 2）", () => {
  it("禁用 bash 后工具集不含之；缺省参数行为不变", async () => {
    const tools = await collectTools("/tmp/ws", [], () => ["bash"]);
    expect(tools.some((t) => t.name === "bash")).toBe(false);
    const untouched = await collectTools("/tmp/ws", []);
    expect(untouched.some((t) => t.name === "bash")).toBe(true);
  });
});

describe("defaults 演进（SP6）", () => {
  it("SECURITY_DEFAULTS.disabledTools 为空数组（全启用零行为变化）", () => {
    const config = SECURITY_DEFAULTS as SecurityConfig;
    expect(config.disabledTools).toEqual([]);
  });
});

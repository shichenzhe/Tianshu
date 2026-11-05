/**
 * 参数级审批 pattern 的执行门行为（security P1-3 / skills-tools-mcp §6-6）：
 * runToolCall 记忆查表——ask 级来源（cmdAsk bash / 文件门 block）可被
 * 工作空间记忆抑制（pattern 行参数级匹配 / 无 pattern 行旧全等语义），
 * 硬线（危险分级/批量删除）永不被记忆抑制（对齐 WorkBuddy bypass
 * 「requires confirmation every time」）。isToolAllowed 双参形态与
 * 旧签名桩兼容性同钉。
 * 内置敏感路径 × 记忆行子不变量（2026-11-05 终审注记）：内置清单全
 * 绝对路径 + pattern 匹配对绝对路径返回 null → pattern 行（即使 `**`）
 * 永远够不到内置敏感路径，block 面审批照挂；整工具行全参抑制为已声明
 * 设计，作对照钉死。
 */
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// tool-gate 传递依赖 Log → electron（prisma-client 顶层读 app.getPath）
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => `/tmp/tianshu-test-user-data-${process.pid}`),
    getAppPath: vi.fn(() => `/tmp/tianshu-test-app-${process.pid}`),
    isPackaged: false,
  },
}));

import { runToolCall } from "../../electron/domains/ai/agent/tool-gate";
import type { AgentStreamOptions } from "../../electron/domains/ai/agent/tool-gate";
import type { ToolDefinition } from "../../electron/domains/ai/agent/file-tools";
import { isRememberedPermission } from "@tianshu/core";
import { makeFileDecider } from "../../electron/domains/security/file-gate";
import {
  SECURITY_DEFAULTS,
  defaultFileBlocklist,
} from "../../electron/domains/security/defaults";
import { normalizeRulePath } from "../../electron/domains/security/file-policy";

const bashDef: ToolDefinition = {
  name: "bash",
  description: "bash",
  parameters: {},
  kind: "write",
  execute: async () => "done",
};

const makeAgent = (
  overrides: Partial<AgentStreamOptions> = {},
): AgentStreamOptions => ({
  sessionId: 1,
  workspacePath: "/tmp/ws",
  fullAccess: () => false,
  isToolAllowed: async () => false,
  requestApproval: async () => true,
  ...overrides,
});

describe("runToolCall 记忆抑制面（参数级审批批）", () => {
  it("isToolAllowed 收到 input：pattern 匹配判定在装配实现侧（透传即达）", async () => {
    const isToolAllowed = vi.fn(async () => false);
    const decideCommand = () => "ask" as const;
    await runToolCall(
      bashDef,
      makeAgent({ isToolAllowed, decideCommand }),
      "t1",
      { command: "git push" },
      undefined,
    );
    expect(isToolAllowed).toHaveBeenCalledWith("bash", { command: "git push" });
  });

  it("bash cmdAsk 命中记忆免审（旧签名 `(toolName) => boolean` 桩兼容生效）", async () => {
    const requestApproval = vi.fn(async () => true);
    const agent = makeAgent({
      // 旧式单参实现——对新增可选参天然兼容（TS 结构化函数赋值）
      isToolAllowed: (async (toolName: string) => toolName === "bash") as never,
      decideCommand: () => "ask" as const,
      requestApproval,
    });
    const out = await runToolCall(bashDef, agent, "t1", { command: "x" }, undefined);
    expect(requestApproval).not.toHaveBeenCalled();
    expect(out).toBe("done");
  });

  it("bash cmdAsk 未命中记忆照旧挂审批（行为不回归）", async () => {
    const requestApproval = vi.fn(async () => true);
    const agent = makeAgent({
      isToolAllowed: async () => false,
      decideCommand: () => "ask" as const,
      requestApproval,
    });
    await runToolCall(bashDef, agent, "t1", { command: "x" }, undefined);
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it("危险分级硬线不被记忆抑制：HIGH 命令记忆命中仍审批（bypass 每次确认）", async () => {
    const requestApproval = vi.fn(async () => true);
    const agent = makeAgent({
      isToolAllowed: async () => true,
      requestApproval,
    });
    // rm -rf / 为危险表 HIGH/CRITICAL 命令（assessCommandRisk 表内项）
    await runToolCall(bashDef, agent, "t1", { command: "rm -rf /" }, undefined);
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it("无 ask 来源不触表：default 档普通命令零额外查询（热路径零开销）", async () => {
    const isToolAllowed = vi.fn(async () => true);
    const agent = makeAgent({ isToolAllowed });
    await runToolCall(bashDef, agent, "t1", { command: "ls" }, undefined);
    expect(isToolAllowed).not.toHaveBeenCalled();
  });

  it("read 类工具（kind read）的文件门 block 不查记忆——新抑制面限 write", async () => {
    const isToolAllowed = vi.fn(async () => true);
    const readDef: ToolDefinition = {
      name: "read",
      description: "read",
      parameters: {},
      kind: "read",
      execute: async () => "content",
    };
    const requestApproval = vi.fn(async () => true);
    const agent = makeAgent({
      isToolAllowed,
      requestApproval,
      decideFileAccess: () => "block" as const,
    });
    await runToolCall(readDef, agent, "t1", { path: "secret.key" }, undefined);
    expect(isToolAllowed).not.toHaveBeenCalled();
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });
});

describe("内置敏感路径 × 记忆行（子不变量钉死，2026-11-05 终审注记）", () => {
  /** 文件门只认 read/write/ls/rm——def 名必须是 "write" 才进判定面 */
  const writeDef: ToolDefinition = {
    name: "write",
    description: "write",
    parameters: {},
    kind: "write",
    execute: async () => "已写入",
  };

  it("pattern 行（即使最宽 `**`）够不到内置敏感绝对路径 → block 面仍审批；整工具行全参抑制（已声明设计）", async () => {
    const WS = "/tmp/ws";
    // 真判定引擎 + 真内置清单（无 extraBuiltin/grantedOf 的基础形态；
    // 纯字符串匹配，目标文件无需真实存在）
    const decideFileAccess = makeFileDecider(
      () => ({ ...SECURITY_DEFAULTS }),
      [],
    );

    // —— 条件①：内置清单条目归一化后全为绝对路径（落在工作空间之外）。
    // 有人往清单加工作空间内相对条目时此断言先红，逼读 defaults.ts 注记
    for (const entry of defaultFileBlocklist(process.platform)) {
      expect(path.isAbsolute(normalizeRulePath(entry, WS))).toBe(true);
    }

    // —— 真清单真命中：~/.ssh/ 下绝对路径（本机 homedir 文字形态）
    const sensitive = path.join(os.homedir(), ".ssh", "config");
    expect(decideFileAccess(sensitive, WS)).toBe("block");

    // 真记忆查表接线（chat.service resolveAgentOptions 同款：core 单源）
    const touched: number[] = [];
    let rows: Array<{ id: number; pattern: string | null }> = [];
    const db = {
      toolPermission: {
        findMany: async () => rows,
        update: async (args: { where: { id: number } }) => {
          touched.push(args.where.id);
          return {};
        },
      },
    };

    // —— 条件② + 行为钉死：最宽 pattern 行 `**` × 内置敏感绝对路径 →
    // normalizeRelativePath 对绝对路径返回 null 不命中 → remembered=false
    // → block 面审批照挂（`**` 都够不到，任何 pattern 行都够不到）
    rows = [{ id: 1, pattern: "**" }];
    const approvals: string[] = [];
    const trackApproval = async (id: string) => {
      approvals.push(id);
      return false;
    };
    const gated = makeAgent({
      workspacePath: WS,
      // 绝对路径越过工作空间边界的合法来源：文件窗口授权清单（spec §6.4）
      grantedPaths: () => [sensitive],
      decideFileAccess,
      isToolAllowed: (toolName, input) =>
        isRememberedPermission(db, 1, toolName, input),
      requestApproval: trackApproval,
    });
    const denied = await runToolCall(writeDef, gated, "t1", {
      path: sensitive,
      content: "x",
    });
    expect(approvals).toHaveLength(1); // block 面仍拦（未被参数级记忆抑制）
    expect(denied).toContain("用户拒绝了此操作");
    expect(touched).toEqual([]); // pattern 行未命中：lastUsedAt 不回写

    // —— 对照（已声明设计）：整工具行（无 pattern）全参数抑制 block 面，
    // 免审直执行——区别于 pattern 行，本就是记忆语义的一部分
    rows = [{ id: 2, pattern: null }];
    const wholeTool = makeAgent({
      workspacePath: WS,
      grantedPaths: () => [sensitive],
      decideFileAccess,
      isToolAllowed: (toolName, input) =>
        isRememberedPermission(db, 1, toolName, input),
      requestApproval: trackApproval,
    });
    const out = await runToolCall(writeDef, wholeTool, "t2", {
      path: sensitive,
      content: "x",
    });
    expect(approvals).toHaveLength(1); // 仍只有上一次——整工具行免审直执行
    expect(out).toBe("已写入");
    expect(touched).toEqual([2]); // 整工具行命中并回写 lastUsedAt
  });
});

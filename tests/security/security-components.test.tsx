// @vitest-environment jsdom
/**
 * 安全中心二级页共享构件测试（终审 S3 + SP6 Task 4）：
 * - validateNonEmpty 抽取共享后行为不变（trim 归一 / 空输入 null）
 * - SandboxCard：四个二级入口（含 SP6 运行时工具）均可点且分派到对应回调
 * - SystemGrantCard（SP6）：full 会话/工具记忆两区块渲染与空态、收回/撤销
 *   走 permission:* invoke 且本地列表即时更新 + toast
 * - RuntimeDetailView（SP6）：四组 13 开关、组名/工具说明来自 i18n、toggle
 *   写 disabledTools（增删工具名、保持名单序）
 * （t 返回 key 的 react-i18next mock 骨架照 plan-item-dialog.test.tsx 先例；
 *   invokeMock/toastMock 手法照 settings-dialog.test.tsx）
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});

// IPC mock：SystemGrantCard 自取数与撤销动作（invokeMock 按通道分发桩值）
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", () => ({
  invoke: async (channel: string, ...args: unknown[]) =>
    invokeMock(channel, ...args),
}));

// toast mock：断言撤销成功反馈
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

import SandboxCard from "../../src-react/domains/security/components/SandboxCard";
import SystemGrantCard from "../../src-react/domains/security/components/SystemGrantCard";
import RuntimeDetailView from "../../src-react/domains/security/components/RuntimeDetailView";
import { validateNonEmpty } from "../../src-react/domains/security/components/validators";
import type {
  BuiltinToolMeta,
  SecurityConfig,
} from "../../src-react/domains/security/model/types";

const config: SecurityConfig = {
  sandboxEnabled: true,
  fileAllowlist: [],
  fileBlocklist: [],
  cmdAllow: [],
  cmdAsk: [],
  programBlacklist: [],
  domainAllow: [],
  domainDeny: [],
  blockAllNetwork: false,
  maliciousDomainProtection: false,
  fileBackupEnabled: true,
  fileBackupMaxSizeMB: 500,
  deleteProtection: true,
  bulkDeleteThreshold: 10,
  disabledTools: [],
};

/** 与 electron/domains/security/defaults.ts 的 BUILTIN_TOOLS 同构（13 项名单序） */
const BUILTIN_TOOLS_FIXTURE: BuiltinToolMeta[] = [
  { name: "read_file", group: "file", kind: "read" },
  { name: "list_dir", group: "file", kind: "read" },
  { name: "search_files", group: "file", kind: "read" },
  { name: "write_file", group: "file", kind: "write" },
  { name: "delete_file", group: "file", kind: "write" },
  { name: "run_command", group: "command", kind: "write" },
  { name: "read_skill", group: "skill", kind: "read" },
  { name: "create_skill", group: "skill", kind: "write" },
  { name: "plan_create_item", group: "plan", kind: "write" },
  { name: "plan_update_status", group: "plan", kind: "write" },
  { name: "plan_append_summary", group: "plan", kind: "write" },
  { name: "plan_list_items", group: "plan", kind: "read" },
  { name: "plan_get_item", group: "plan", kind: "read" },
];

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
  toastMock.success.mockClear();
  toastMock.error.mockClear();
});

describe("validateNonEmpty（共享抽取）", () => {
  it("trim 后非空返回归一值", () => {
    expect(validateNonEmpty("  a.com  ")).toBe("a.com");
    expect(validateNonEmpty("a.com")).toBe("a.com");
  });

  it("空/纯空白输入返回 null", () => {
    expect(validateNonEmpty("")).toBeNull();
    expect(validateNonEmpty("   ")).toBeNull();
  });
});

describe("SandboxCard（死分支删除）", () => {
  it("三个二级入口均可点且分派到对应回调；无禁用占位/comingSoon 残留", () => {
    const onOpenCommand = vi.fn();
    const onOpenFile = vi.fn();
    const onOpenNetwork = vi.fn();
    render(
      <SandboxCard
        config={config}
        onToggle={vi.fn()}
        onOpenCommand={onOpenCommand}
        onOpenFile={onOpenFile}
        onOpenNetwork={onOpenNetwork}
        onOpenRuntime={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("security:sandbox.command"));
    fireEvent.click(screen.getByText("security:sandbox.file"));
    fireEvent.click(screen.getByText("security:sandbox.network"));
    expect(onOpenCommand).toHaveBeenCalledTimes(1);
    expect(onOpenFile).toHaveBeenCalledTimes(1);
    expect(onOpenNetwork).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[aria-disabled]")).toBeNull();
    expect(screen.queryByText("security:sandbox.comingSoon")).toBeNull();
  });
});

describe("SandboxCard（SP6 运行时工具第四入口）", () => {
  it("「运行时工具」行存在且可点，分派到 onOpenRuntime 回调", () => {
    const onOpenRuntime = vi.fn();
    render(
      <SandboxCard
        config={config}
        onToggle={vi.fn()}
        onOpenCommand={vi.fn()}
        onOpenFile={vi.fn()}
        onOpenNetwork={vi.fn()}
        onOpenRuntime={onOpenRuntime}
      />,
    );
    expect(screen.getByText("security:sandbox.runtimeDesc")).toBeTruthy();
    fireEvent.click(screen.getByText("security:sandbox.runtime"));
    expect(onOpenRuntime).toHaveBeenCalledTimes(1);
  });
});

describe("SystemGrantCard（SP6 系统授权卡）", () => {
  const REMEMBERED_ROW = {
    id: 7,
    workspaceName: "空间A",
    toolName: "run_command",
    createdAt: "2026-09-01T08:00:00Z",
  };

  /** 按通道分发桩值：两列表通道返回给定行，其余（撤销类）返回 undefined */
  const stubGrants = (full: unknown[] = [], remembered: unknown[] = []) => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "permission:listFullGrants") return full;
      if (channel === "permission:listRemembered") return remembered;
      return undefined;
    });
  };

  it("两区块渲染：full 会话行（标题 + 完全访问 badge）与工具记忆行（空间名 + 等宽工具名）", async () => {
    stubGrants([{ sessionId: 2, title: "任务B" }], [REMEMBERED_ROW]);
    render(<SystemGrantCard />);
    expect(await screen.findByText("任务B")).toBeTruthy();
    expect(screen.getByText("security:systemGrant.fullTitle")).toBeTruthy();
    expect(screen.getByText("security:systemGrant.fullBadge")).toBeTruthy();
    expect(screen.getByText("空间A")).toBeTruthy();
    expect(screen.getByText("run_command").className).toContain("font-mono");
    expect(
      screen.getByText("security:systemGrant.rememberedTitle"),
    ).toBeTruthy();
  });

  it("两列表空时渲染空态文案，一键收回按钮禁用", async () => {
    stubGrants([], []);
    render(<SystemGrantCard />);
    expect(
      await screen.findByText("security:systemGrant.emptyFull"),
    ).toBeTruthy();
    expect(
      screen.getByText("security:systemGrant.emptyRemembered"),
    ).toBeTruthy();
    const revokeAllFull = screen.getByRole("button", {
      name: "security:systemGrant.revokeAllFull",
    }) as HTMLButtonElement;
    expect(revokeAllFull.disabled).toBe(true);
  });

  it("一键收回全部：确认后 revokeAllFull invoke + 列表清空 + toast", async () => {
    stubGrants([{ sessionId: 2, title: "任务B" }], []);
    render(<SystemGrantCard />);
    await screen.findByText("任务B");
    fireEvent.click(
      screen.getByRole("button", {
        name: "security:systemGrant.revokeAllFull",
      }),
    );
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "common:confirm",
      }),
    );
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("permission:revokeAllFull"),
    );
    await waitFor(() =>
      expect(screen.getByText("security:systemGrant.emptyFull")).toBeTruthy(),
    );
    expect(toastMock.success).toHaveBeenCalledWith(
      "security:systemGrant.revoked",
    );
  });

  it("工具记忆行内撤销：revokeRemembered(id) + 行消失 + toast", async () => {
    stubGrants([], [REMEMBERED_ROW]);
    render(<SystemGrantCard />);
    await screen.findByText("空间A");
    fireEvent.click(
      screen.getByRole("button", { name: "security:systemGrant.revoke" }),
    );
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("permission:revokeRemembered", 7),
    );
    await waitFor(() =>
      expect(
        screen.getByText("security:systemGrant.emptyRemembered"),
      ).toBeTruthy(),
    );
    expect(toastMock.success).toHaveBeenCalledWith(
      "security:systemGrant.revoked",
    );
  });

  it("全部撤销：确认后 revokeAllRemembered invoke + 列表清空", async () => {
    stubGrants([], [REMEMBERED_ROW]);
    render(<SystemGrantCard />);
    await screen.findByText("空间A");
    fireEvent.click(
      screen.getByRole("button", { name: "security:systemGrant.revokeAll" }),
    );
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "common:confirm",
      }),
    );
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("permission:revokeAllRemembered"),
    );
    await waitFor(() =>
      expect(
        screen.getByText("security:systemGrant.emptyRemembered"),
      ).toBeTruthy(),
    );
  });
});

describe("RuntimeDetailView（SP6 运行时工具二级页）", () => {
  const renderView = (disabledTools: string[]) => {
    const onToggle = vi.fn();
    render(
      <RuntimeDetailView
        config={{ ...config, disabledTools }}
        defaults={{ builtinTools: BUILTIN_TOOLS_FIXTURE }}
        onBack={vi.fn()}
        onToggle={onToggle}
      />,
    );
    return onToggle;
  };

  it("四组渲染 13 个开关；组名/工具说明/kind badge 均来自 i18n", () => {
    renderView([]);
    expect(screen.getByText("security:runtimeDetail.groupFile")).toBeTruthy();
    expect(
      screen.getByText("security:runtimeDetail.groupCommand"),
    ).toBeTruthy();
    expect(screen.getByText("security:runtimeDetail.groupSkill")).toBeTruthy();
    expect(screen.getByText("security:runtimeDetail.groupPlan")).toBeTruthy();
    expect(screen.getAllByRole("switch")).toHaveLength(13);
    expect(
      screen.getByText("security:runtimeDetail.tools.read_file"),
    ).toBeTruthy();
    expect(
      screen.getByText("security:runtimeDetail.tools.run_command"),
    ).toBeTruthy();
    // kind badge 每工具一枚：13 工具中 6 读 7 写
    expect(screen.getAllByText("security:runtimeDetail.kindRead")).toHaveLength(
      6,
    );
    expect(
      screen.getAllByText("security:runtimeDetail.kindWrite"),
    ).toHaveLength(7);
  });

  it("开关状态 = !disabledTools.includes(name)（禁用工具未选中）", () => {
    renderView(["write_file", "run_command"]);
    expect(
      screen
        .getAllByRole("switch")
        .map((el) => el.getAttribute("aria-checked")),
    ).toEqual([
      "true",
      "true",
      "true",
      "false",
      "true",
      "false",
      "true",
      "true",
      "true",
      "true",
      "true",
      "true",
      "true",
    ]);
  });

  it("toggle 写 disabledTools：移除被开启项/追加被关闭项，保持名单序", () => {
    const onToggle = renderView(["run_command"]);
    const switches = screen.getAllByRole("switch");
    // 开启 run_command → 禁用清单清空
    fireEvent.click(switches[5]);
    expect(onToggle).toHaveBeenCalledWith("disabledTools", []);
    // 禁用 read_file → 追加后保持名单序（read_file 在 run_command 前）
    fireEvent.click(switches[0]);
    expect(onToggle).toHaveBeenLastCalledWith("disabledTools", [
      "read_file",
      "run_command",
    ]);
  });
});

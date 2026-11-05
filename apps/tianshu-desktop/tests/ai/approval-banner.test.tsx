// @vitest-environment jsdom
/**
 * 审批横幅「始终允许」下拉（参数级审批批 security P1-3）：
 * bash/write 类工具出参数前缀主选项（suggestRememberPattern 与执行侧
 * matchPermissionPattern 同源），下拉副项为整工具；其余工具维持单按钮。
 * 本地态两步（rememberTool 带 pattern → agent:approve）；i18n mock 返回
 * key（security-components.test.tsx 先例）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", () => ({
  invoke: async (channel: string, ...args: unknown[]) =>
    invokeMock(channel, ...args),
}));

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

import ApprovalBanner from "../../src-react/domains/ai/chat/components/ApprovalBanner";

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
  toastMock.error.mockReset();
});

describe("ApprovalBanner 参数级「始终允许」选项", () => {
  it("bash：主按钮为前缀选项——rememberTool 带 pattern（git *）后放行", async () => {
    invokeMock.mockResolvedValue(undefined);
    render(
      <ApprovalBanner
        sessionId={1}
        toolCallId="t1"
        toolName="bash"
        argSummary="bash → git push"
        args={{ command: "git push" }}
        workspaceId={5}
        onDecided={() => {}}
      />,
    );
    // 主选项（前缀）点击：先记忆（带 pattern）再放行
    fireEvent.click(
      screen.getByRole("button", { name: "chat:tool.approveRememberPrefix" }),
    );
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "permission:rememberTool",
        5,
        "bash",
        "git *",
      ),
    );
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("agent:approve", "t1", true),
    );
    // 副项触发器在场（整工具下拉）
    expect(
      screen.getByRole("button", { name: "chat:tool.approveRememberMore" }),
    ).toBeTruthy();
  });

  it("write：路径目录前缀（src/x/**）；根级文件回落单按钮（无前缀选项）", () => {
    invokeMock.mockResolvedValue(undefined);
    const { rerender } = render(
      <ApprovalBanner
        sessionId={1}
        toolCallId="t1"
        toolName="write"
        argSummary="write → src/x/a.ts"
        args={{ path: "src/x/a.ts" }}
        workspaceId={5}
        onDecided={() => {}}
      />,
    );
    expect(
      screen.getByRole("button", { name: "chat:tool.approveRememberPrefix" }),
    ).toBeTruthy();

    // 根级文件 a.txt 无目录前缀：无 suggestRememberPattern → 单按钮形态
    rerender(
      <ApprovalBanner
        sessionId={1}
        toolCallId="t1"
        toolName="write"
        argSummary="write → a.txt"
        args={{ path: "a.txt" }}
        workspaceId={5}
        onDecided={() => {}}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "chat:tool.approveRememberPrefix" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "chat:tool.approveRemember" }),
    ).toBeTruthy();
  });

  it("非参数级工具（mcp__）：单按钮「允许并记住」（整工具，无 pattern）", async () => {
    invokeMock.mockResolvedValue(undefined);
    render(
      <ApprovalBanner
        sessionId={1}
        toolCallId="t1"
        toolName="mcp__srv__publish"
        argSummary={'mcp__srv__publish → {"title":"hi"}'}
        args={{ title: "hi" }}
        workspaceId={5}
        onDecided={() => {}}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "chat:tool.approveRemember" }),
    );
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "permission:rememberTool",
        5,
        "mcp__srv__publish",
        undefined,
      ),
    );
  });

  it("含元字符的 bash 命令不提供前缀选项（防误扩——安全红线同源）", () => {
    render(
      <ApprovalBanner
        sessionId={1}
        toolCallId="t1"
        toolName="bash"
        argSummary="bash → git fetch && rm -rf /"
        args={{ command: "git fetch && rm -rf /" }}
        workspaceId={5}
        onDecided={() => {}}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "chat:tool.approveRememberPrefix" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "chat:tool.approveRemember" }),
    ).toBeTruthy();
  });
});

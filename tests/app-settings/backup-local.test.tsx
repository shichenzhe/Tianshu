// @vitest-environment jsdom
/**
 * BackupGroup 本地链路（无服务端）：备份到本地/从本地档案恢复两按钮在
 * 未配任何连接时也可见可用（功能动机即「无服务端备份」）；点击后走
 * 对应 IPC；选择器取消（返回 null）静默——无 toast、无重启横条。
 * mock 面：backup-group-claim.test.tsx 同款（react-i18next/sonner/@/i18n
 * 直替，@/lib/ipc 与 server.api 按通道打桩）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/i18n", () => ({ default: { t: (k: string) => k } }));
vi.mock("@/lib/ipc", () => ({
  invoke: vi.fn(),
  on: vi.fn(() => () => undefined),
}));
vi.mock("@/domains/ai/server/api/server.api", () => ({
  default: { listConnections: vi.fn() },
}));

import BackupGroup from "@/domains/app-settings/components/BackupGroup";
import { invoke } from "@/lib/ipc";
import { toast } from "sonner";
import ServerApi from "@/domains/ai/server/api/server.api";

/** 零连接（本地链路的存在意义：无服务端也要能备份/恢复） */
function setupNoConnections(): void {
  vi.mocked(ServerApi.listConnections).mockResolvedValue({
    activeConnId: "",
    connections: [],
  });
}

describe("BackupGroup 本地链路（无服务端）", () => {
  beforeEach(() => {
    vi.mocked(ServerApi.listConnections).mockReset();
    vi.mocked(invoke).mockReset();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
  });
  afterEach(cleanup);

  it("零连接下两按钮可见；备份到本地 → invoke backup:create:local → 成功 toast 带路径", async () => {
    setupNoConnections();
    vi.mocked(invoke).mockResolvedValue({
      destPath: "/Volumes/Backup/tianshu-backup-x.tar.gz",
      fileSize: 2048,
      sha256: "sha",
    });
    render(<BackupGroup />);
    const localBtn = await screen.findByText("settings:backupToLocal");
    expect(screen.getByText("settings:backupLocalRestore")).toBeTruthy();
    fireEvent.click(localBtn);
    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("backup:create:local"),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it("备份到本地取消（返回 null）→ 静默无 toast", async () => {
    setupNoConnections();
    vi.mocked(invoke).mockResolvedValue(null);
    render(<BackupGroup />);
    fireEvent.click(await screen.findByText("settings:backupToLocal"));
    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("backup:create:local"),
    );
    // null 落定后无成功/失败提示（等待一个微任务周期再断言）
    await waitFor(() =>
      expect(vi.mocked(toast.success)).not.toHaveBeenCalled(),
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("从本地档案恢复：确认弹窗 → 确认 → invoke backup:restore:local → 重启横条", async () => {
    setupNoConnections();
    vi.mocked(invoke).mockResolvedValue({ relaunchRequired: true });
    render(<BackupGroup />);
    fireEvent.click(await screen.findByText("settings:backupLocalRestore"));
    // 二次确认弹窗（本地档案版标题）出现，确认动作执行恢复
    expect(
      await screen.findByText("settings:backupLocalRestoreConfirmTitle"),
    ).toBeTruthy();
    fireEvent.click(screen.getByText("settings:backupRestore"));
    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("backup:restore:local"),
    );
    // 重启横条复用远端恢复路径
    expect(
      await screen.findByText("settings:backupRelaunching"),
    ).toBeTruthy();
  });

  it("从本地档案恢复取消（选择器 null）→ 无重启横条", async () => {
    setupNoConnections();
    vi.mocked(invoke).mockResolvedValue(null);
    render(<BackupGroup />);
    fireEvent.click(await screen.findByText("settings:backupLocalRestore"));
    fireEvent.click(
      await screen.findByText("settings:backupLocalRestoreConfirmTitle"),
    );
    // 确认按钮文案是 settings:backupRestore——但同 key 行内按钮零连接时
    // 不渲染，弹窗内唯一
    fireEvent.click(screen.getByText("settings:backupRestore"));
    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("backup:restore:local"),
    );
    await waitFor(() =>
      expect(screen.queryByText("settings:backupRelaunching")).toBeNull(),
    );
  });
});

// @vitest-environment jsdom
/**
 * BackupGroup 本地链路（无服务端）：备份到本地/从本地档案恢复两按钮在
 * 未配任何连接时也可见可用（功能动机即「无服务端备份」）；选择器取消
 * （返回 null）静默——无 toast、无重启横条。口令加密批（安全审查
 * 2026-11-02 剩余待办 1）：导出经口令弹窗（留空=不加密；两次输入一致
 * 才可导出）；恢复确认弹窗含口令框（加密档填写，错口令 toast 透传）。
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

/** 打开导出口令弹窗（点击「备份到本地」后弹窗先行，主进程选路径在确认后） */
async function openExportDialog(): Promise<void> {
  fireEvent.click(await screen.findByText("settings:backupToLocal"));
  await screen.findByText("settings:backupPassphraseTitle");
}

describe("BackupGroup 本地链路（无服务端）", () => {
  beforeEach(() => {
    vi.mocked(ServerApi.listConnections).mockReset();
    vi.mocked(invoke).mockReset();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
  });
  afterEach(cleanup);

  it("零连接下两按钮可见；导出留空口令 → invoke backup:create:local（undefined）→ 成功 toast 带路径", async () => {
    setupNoConnections();
    vi.mocked(invoke).mockResolvedValue({
      destPath: "/Volumes/Backup/tianshu-backup-x.tar.gz",
      fileSize: 2048,
      sha256: "sha",
    });
    render(<BackupGroup />);
    await openExportDialog();
    fireEvent.click(screen.getByText("settings:backupPassphraseAction"));
    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith(
        "backup:create:local",
        undefined,
      ),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it("导出填口令（两次一致）→ invoke 带口令", async () => {
    setupNoConnections();
    vi.mocked(invoke).mockResolvedValue({
      destPath: "/tmp/x.tsbak",
      fileSize: 10,
      sha256: "sha",
    });
    render(<BackupGroup />);
    await openExportDialog();
    fireEvent.change(screen.getByLabelText("settings:backupPassphraseLabel"), {
      target: { value: "我的口令" },
    });
    fireEvent.change(
      screen.getByLabelText("settings:backupPassphraseRepeatLabel"),
      { target: { value: "我的口令" } },
    );
    fireEvent.click(screen.getByText("settings:backupPassphraseAction"));
    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith(
        "backup:create:local",
        "我的口令",
      ),
    );
  });

  it("导出两次口令不一致 → mismatch 提示 + 导出按钮禁用（不 invoke）", async () => {
    setupNoConnections();
    render(<BackupGroup />);
    await openExportDialog();
    fireEvent.change(screen.getByLabelText("settings:backupPassphraseLabel"), {
      target: { value: "aaa" },
    });
    fireEvent.change(
      screen.getByLabelText("settings:backupPassphraseRepeatLabel"),
      { target: { value: "bbb" } },
    );
    expect(await screen.findByText("settings:backupPassphraseMismatch")).toBeTruthy();
    const action = screen.getByText("settings:backupPassphraseAction").closest("button")!;
    expect(action.hasAttribute("disabled")).toBe(true);
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
  });

  it("导出口令弹窗取消 → 不 invoke（主进程选路径都不会发生）", async () => {
    setupNoConnections();
    render(<BackupGroup />);
    await openExportDialog();
    fireEvent.click(screen.getByText("common:cancel"));
    await waitFor(() =>
      expect(vi.mocked(invoke)).not.toHaveBeenCalled(),
    );
  });

  it("从本地档案恢复：确认弹窗含口令框，留空 → invoke backup:restore:local（undefined）→ 重启横条", async () => {
    setupNoConnections();
    vi.mocked(invoke).mockResolvedValue({ relaunchRequired: true });
    render(<BackupGroup />);
    fireEvent.click(await screen.findByText("settings:backupLocalRestore"));
    expect(
      await screen.findByText("settings:backupLocalRestoreConfirmTitle"),
    ).toBeTruthy();
    expect(
      screen.getByLabelText("settings:backupRestorePassphraseLabel"),
    ).toBeTruthy();
    fireEvent.click(screen.getByText("settings:backupRestore"));
    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith(
        "backup:restore:local",
        undefined,
      ),
    );
    expect(
      await screen.findByText("settings:backupRelaunching"),
    ).toBeTruthy();
  });

  it("从本地档案恢复：填口令 → invoke 带口令；错口令 → toast 透传主进程文案", async () => {
    setupNoConnections();
    vi.mocked(invoke).mockRejectedValue(
      new Error("备份档口令错误或档案已损坏"),
    );
    render(<BackupGroup />);
    fireEvent.click(await screen.findByText("settings:backupLocalRestore"));
    await screen.findByText("settings:backupLocalRestoreConfirmTitle");
    fireEvent.change(
      screen.getByLabelText("settings:backupRestorePassphraseLabel"),
      { target: { value: "试一下" } },
    );
    fireEvent.click(screen.getByText("settings:backupRestore"));
    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith(
        "backup:restore:local",
        "试一下",
      ),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("备份档口令错误或档案已损坏"),
    );
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
      expect(vi.mocked(invoke)).toHaveBeenCalledWith(
        "backup:restore:local",
        undefined,
      ),
    );
    await waitFor(() =>
      expect(screen.queryByText("settings:backupRelaunching")).toBeNull(),
    );
  });
});

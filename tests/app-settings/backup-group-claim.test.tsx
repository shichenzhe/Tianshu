// @vitest-environment jsdom
/**
 * BackupGroup 申领小节显隐（终审 I3 被踢除设备恢复路径）：
 * - 已配 backupToken 的连接原不显申领小节——admin 踢除后该 token 成死
 *   凭据，仅 toast 会把恢复入口锁死；backup:list 失败错面含 HTTP 401/
 *   「备份 token」时须置失效旗标：小节重现 + 顶部失效提示文案
 * - list 成功（凭据有效）→ 小节保持隐藏；从未申领（无 backupToken）→
 *   小节显示且无失效提示
 * mock 面：react-i18next/sonner/@/i18n 直替（LongTextEditorDialog 同款），
 * @/lib/ipc 与 server.api 连接列表按通道/数据面打桩。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// 全量 mock 的 react-i18next 缺 initReactI18next；真实 i18n jsdom 下告警
// （tests/app-settings/long-text-editor-dialog.test.tsx 同款）
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
import ServerApi from "@/domains/ai/server/api/server.api";
import type { ConnectionListResult } from "@/domains/ai/server/api/server.api";

/** 单直连（自动选中，免 Radix Select 交互）；backupToken 按景注入 */
function setupConnection(backupToken?: string): void {
  const conn = {
    id: "c1",
    mode: "direct",
    name: "主机 A",
    ...(backupToken ? { backupToken } : {}),
  };
  vi.mocked(ServerApi.listConnections).mockResolvedValue({
    activeConnId: "c1",
    connections: [conn],
  } as unknown as ConnectionListResult);
}

/** backup:list 行为按景注入（其余管理面通道兜底空值——client 视角不触达） */
function setupList(behavior: () => Promise<unknown>): void {
  vi.mocked(invoke).mockImplementation((async (channel: string) => {
    if (channel === "backup:list") return behavior();
    if (channel === "backup:invites:list") return [];
    if (channel === "backup:clients:list") return [];
    throw new Error(`unexpected channel: ${channel}`);
  }) as typeof invoke);
}

describe("BackupGroup 申领小节显隐（终审 I3）", () => {
  beforeEach(() => {
    vi.mocked(ServerApi.listConnections).mockReset();
    vi.mocked(invoke).mockReset();
  });
  afterEach(cleanup);

  it("死凭据恢复路径：已配 backupToken 但 list 401/备份 token 错 → 小节重现 + 失效提示", async () => {
    setupConnection("stale-tok");
    setupList(() =>
      Promise.reject(
        new Error(
          "backup 请求失败（/backup/list）：HTTP 401 code=401 无效的备份 token",
        ),
      ),
    );
    render(<BackupGroup />);
    // 失效旗标立起：小节重现（原按「已配 backupToken」隐藏）+ 顶部提示
    expect(await screen.findByText("settings:backupClaimTitle")).toBeTruthy();
    expect(screen.getByText("settings:backupClaimStaleHint")).toBeTruthy();
  });

  it("凭据有效：list 成功 → 已配 backupToken 的小节保持隐藏", async () => {
    setupConnection("good-tok");
    setupList(() =>
      Promise.resolve({
        backups: [],
        viewer: { kind: "client", clientId: "imac-1" },
      }),
    );
    render(<BackupGroup />);
    // list 落定标志（空列表文案出现）后再断言小节不在场
    await waitFor(() =>
      expect(screen.getByText("settings:backupListEmpty")).toBeTruthy(),
    );
    expect(screen.queryByText("settings:backupClaimTitle")).toBeNull();
  });

  it("从未申领：无 backupToken → 小节显示且无失效提示", async () => {
    setupConnection(undefined);
    setupList(() =>
      Promise.resolve({ backups: [], viewer: { kind: "admin" } }),
    );
    render(<BackupGroup />);
    expect(await screen.findByText("settings:backupClaimTitle")).toBeTruthy();
    expect(screen.queryByText("settings:backupClaimStaleHint")).toBeNull();
  });
});

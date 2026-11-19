// @vitest-environment jsdom
/**
 * BackupGroup 备份目标主机过滤 + 自动拉列表失败静默化（2026-11-09 修复）：
 * - 桌面 face 连接（capabilities 含 "backup"——被控面专属能力，无头端
 *   存储面不报）不得出现在备份主机下拉：face 的 /backup/list 是「遥控它
 *   读它自己的备份」语义，把桌面端当备份存储端是语义错配（嵌套
 *   200/5000+401/4010 错误 toast 的根因）；默认选中（活动连接/首个
 *   direct）也必须跳过 face 连接
 * - 自动 backup:list 失败不再全局 toast（进设置页即被轰炸），改为组内
 *   行内错误文案；tokenInvalid 旗标（申领小节恢复）行为保留
 * mock 面：backup-group-claim.test.tsx 同款（i18n/sonner/ipc/server.api）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

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
import ServerApi from "@/domains/ai/server/api/server.api";
import type { ConnectionListResult } from "@/domains/ai/server/api/server.api";
import { toast } from "sonner";

/** 桌面 face 连接（DESKTOP_CAPABILITIES 含 backup；活动连接——默认选中
 *  的首个候选，必须被过滤跳过） */
const FACE_CONN = {
  id: "face-1",
  mode: "direct",
  name: "桌面 B",
  capabilities: ["chat", "provider", "ui-drive", "backup"],
};
/** 无头端连接（CAPABILITIES 无 backup——存储端不报该能力） */
const HEADLESS_CONN = {
  id: "hs-1",
  mode: "direct",
  name: "无头端",
  capabilities: ["chat", "provider", "graph", "files", "library", "monitor"],
};

function setupConnections(
  connections: unknown[],
  activeConnId: string | null,
): void {
  vi.mocked(ServerApi.listConnections).mockResolvedValue({
    activeConnId,
    connections,
  } as unknown as ConnectionListResult);
}

function setupList(behavior: () => Promise<unknown>): void {
  vi.mocked(invoke).mockImplementation((async (channel: string) => {
    if (channel === "backup:list") return behavior();
    if (channel === "backup:invites:list") return [];
    if (channel === "backup:clients:list") return [];
    throw new Error(`unexpected channel: ${channel}`);
  }) as typeof invoke);
}

describe("BackupGroup 备份主机过滤与失败静默化", () => {
  beforeEach(() => {
    vi.mocked(ServerApi.listConnections).mockReset();
    vi.mocked(invoke).mockReset();
    vi.mocked(toast.error).mockClear();
  });
  afterEach(cleanup);

  it("活动连接是桌面 face：过滤跳过，默认选中无头端并对它拉列表", async () => {
    setupConnections([FACE_CONN, HEADLESS_CONN], FACE_CONN.id);
    setupList(() =>
      Promise.resolve({
        backups: [],
        viewer: { kind: "client", clientId: "imac-1" },
      }),
    );
    render(<BackupGroup />);
    // 自动 list 只对无头端发起（face 被过滤，非它莫属）
    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith(
        "backup:list",
        HEADLESS_CONN.id,
      ),
    );
    // face 连接不进下拉选项
    expect(screen.queryByText("桌面 B")).toBeNull();
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });

  it("全部 direct 都是桌面 face：不发 backup:list，显示无主机提示", async () => {
    setupConnections([FACE_CONN], FACE_CONN.id);
    setupList(() =>
      Promise.resolve({ backups: [], viewer: { kind: "client" } }),
    );
    render(<BackupGroup />);
    // 连接列表已落定（loading 结束）后仍无 list 调用、无选项、有提示
    await waitFor(() =>
      expect(screen.getByText("settings:backupNoHeadlessHost")).toBeTruthy(),
    );
    expect(
      vi.mocked(invoke).mock.calls.some(([ch]) => ch === "backup:list"),
    ).toBe(false);
    expect(screen.queryByText("桌面 B")).toBeNull();
  });

  it("自动拉列表失败：不弹全局 toast，组内行内错误文案", async () => {
    setupConnections([HEADLESS_CONN], HEADLESS_CONN.id);
    setupList(() =>
      Promise.reject(
        new Error("backup 请求失败（/backup/list）：HTTP 401 code=4010 未认证"),
      ),
    );
    render(<BackupGroup />);
    // 行内错误文案出现（t mock 不做插值，断言 key 前缀在场即可——错误
    // 细节随 message 插值传入由实现保证）；全局 toast 不弹
    await waitFor(() =>
      expect(screen.getByText(/settings:backupListLoadFailed/)).toBeTruthy(),
    );
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });
});

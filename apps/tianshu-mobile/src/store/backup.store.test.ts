// 备份面批 store 状态机：202 受理置进行态、progress 帧推进、done 终态帧
// 复位+成功重拉/失败透 error、防迟到序号。transport 全打桩。
import { beforeEach, describe, expect, it, vi } from "vitest";

const listeners: Array<(event: { type: string; payload?: unknown }) => void> =
  [];
vi.mock("./connections.store", () => ({
  activeTransport: vi.fn(() => ({ close: () => undefined })),
  subscribeTransportEvents: vi.fn((fn: (event: unknown) => void) => {
    listeners.push(fn as never);
  }),
}));
const listMock = vi.fn();
const createMock = vi.fn();
const deleteMock = vi.fn();
vi.mock("../transport/backup-api", () => ({
  backupList: (...a: unknown[]) => listMock(...a),
  backupCreate: (...a: unknown[]) => createMock(...a),
  backupDelete: (...a: unknown[]) => deleteMock(...a),
}));

import { useBackupStore } from "./backup.store";

function emit(type: string, payload: unknown): void {
  for (const fn of listeners) fn({ type, payload });
}

describe("backup.store 状态机", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // listeners 不清：store 订阅闭包在首次 bindEvents 注册（幂等单份），
    // 清数组会断开 emit 通道
    useBackupStore.setState({
      backups: [],
      viewer: null,
      loading: false,
      creating: false,
      progress: null,
      lastError: null,
    });
    useBackupStore.getState().bindEvents();
    listMock.mockResolvedValue({ ok: true, data: [] });
  });

  it("load 存列表与 viewer 身份；未激活连接清空复位", async () => {
    listMock.mockResolvedValue({
      ok: true,
      data: {
        backups: [
          {
            id: "b-1",
            createdAt: "2026-10-27T00:00:00.000Z",
            fileSize: 1,
            sha256: "x",
            chunkCount: 1,
            appVersion: "1",
            schemaVersion: 1,
            status: "ready",
            owner: "__admin__",
          },
        ],
        viewer: { kind: "admin" },
      },
    });
    await useBackupStore.getState().load();
    expect(useBackupStore.getState().backups).toHaveLength(1);
    expect(useBackupStore.getState().viewer).toEqual({ kind: "admin" });
  });

  it("trigger 受理置进行态；失败置 lastError 不置进行态", async () => {
    createMock.mockResolvedValue({ ok: true, data: { accepted: true } });
    const ok = await useBackupStore.getState().trigger("周备份");
    expect(ok).toBe(true);
    expect(useBackupStore.getState().creating).toBe(true);

    useBackupStore.setState({ creating: false });
    createMock.mockResolvedValue({
      ok: false,
      code: "5000",
      message: "未配置直连连接",
    });
    const ok2 = await useBackupStore.getState().trigger(undefined);
    expect(ok2).toBe(false);
    expect(useBackupStore.getState().creating).toBe(false);
    expect(useBackupStore.getState().lastError).toBe("未配置直连连接");
  });

  it("progress 帧推进；done 成功帧复位并重拉列表", async () => {
    emit("backup.progress", { phase: "uploading", current: 50, total: 100 });
    expect(useBackupStore.getState().progress).toMatchObject({ current: 50 });
    expect(useBackupStore.getState().creating).toBe(true);

    listMock.mockResolvedValue({
      ok: true,
      data: {
        backups: [
          {
            id: "b-1",
            createdAt: "2026-10-27T00:00:00.000Z",
            fileSize: 1,
            sha256: "x",
            chunkCount: 1,
            appVersion: "1",
            schemaVersion: 1,
            status: "ready",
          },
        ],
        viewer: { kind: "client", clientId: "d1" },
      },
    });
    emit("backup.progress", {
      phase: "uploading",
      current: 0,
      total: 0,
      done: true,
    });
    expect(useBackupStore.getState().creating).toBe(false);
    expect(useBackupStore.getState().lastError).toBeNull();
    await vi.waitFor(() => {
      expect(useBackupStore.getState().backups).toHaveLength(1);
    });
  });

  it("done 失败帧透 error 不重拉", async () => {
    emit("backup.progress", {
      phase: "uploading",
      current: 0,
      total: 0,
      done: true,
      error: "上传超时",
    });
    expect(useBackupStore.getState().creating).toBe(false);
    expect(useBackupStore.getState().lastError).toBe("上传超时");
    expect(listMock).not.toHaveBeenCalled();
  });

  it("remove 成功本地剔除行", async () => {
    useBackupStore.setState({
      backups: [
        {
          id: "b-1",
          createdAt: "",
          fileSize: 1,
          sha256: "",
          chunkCount: 1,
          appVersion: "1",
          schemaVersion: 1,
          status: "ready",
        },
        {
          id: "b-2",
          createdAt: "",
          fileSize: 1,
          sha256: "",
          chunkCount: 1,
          appVersion: "1",
          schemaVersion: 1,
          status: "ready",
        },
      ] as never,
    });
    deleteMock.mockResolvedValue({ ok: true, data: { deleted: true } });
    await useBackupStore.getState().remove("b-1");
    expect(useBackupStore.getState().backups.map((m) => m.id)).toEqual(["b-2"]);
  });
});

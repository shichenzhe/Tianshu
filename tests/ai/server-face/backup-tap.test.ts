// 备份面批 backup-tap 直测：connId 自动解析（首个 direct/未配置业务错）、
// list/delete 代理转发、create 202 受理+后台终态帧（done/error）+互斥。
// face-events 的 publishFaceEvent 打桩收集（事件面由 face-events 自身守卫）。
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: vi.fn(() => "/tmp/tianshu-backup-test") },
}));
vi.mock("../../../electron/commons/Log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const published = vi.hoisted(
  () => [] as Array<{ type: string; payload: unknown }>,
);
vi.mock("../../../electron/domains/server-face/face-events", () => ({
  publishFaceEvent: (event: { type: string; payload: unknown }) => {
    published.push(event);
  },
}));

import { createBackupFace } from "../../../electron/domains/server-face/backup-tap";
import {
  createBackupNow,
  deleteBackupById,
  listBackupsWithViewer,
} from "../../../electron/domains/backup/ipc";

vi.mock("../../../electron/domains/backup/ipc", () => ({
  createBackupNow: vi.fn(),
  deleteBackupById: vi.fn(),
  listBackupsWithViewer: vi.fn(),
}));

const createBackupNowMock = createBackupNow as unknown as ReturnType<
  typeof vi.fn
>;
const deleteBackupByIdMock = deleteBackupById as unknown as ReturnType<
  typeof vi.fn
>;
const listWithViewerMock = listBackupsWithViewer as unknown as ReturnType<
  typeof vi.fn
>;

function makeFace(connection: string | null) {
  return createBackupFace({
    backupDeps: {} as never,
    resolveConnection: vi.fn(async () => connection),
  });
}

describe("backup-tap：connId 解析与代理", () => {
  it("未配置 direct 连接：list/delete/create 业务错", async () => {
    const face = makeFace(null);
    await expect(face.list()).rejects.toThrow("未配置直连连接");
    await expect(face.delete("b-1")).rejects.toThrow("未配置直连连接");
    await expect(face.create(undefined)).rejects.toThrow("未配置直连连接");
  });

  it("list/delete 转发（connId 注入；list 透传 viewer 身份）", async () => {
    const listPayload = {
      backups: [],
      viewer: { kind: "admin" as const },
    };
    listWithViewerMock.mockResolvedValue(listPayload);
    deleteBackupByIdMock.mockResolvedValue(undefined);
    const face = makeFace("conn-1");
    await expect(face.list()).resolves.toEqual(listPayload);
    expect(listWithViewerMock).toHaveBeenCalledWith(
      "conn-1",
      expect.anything(),
    );
    await face.delete("b-1");
    expect(deleteBackupByIdMock).toHaveBeenCalledWith(
      "conn-1",
      "b-1",
      expect.anything(),
    );
  });
});

describe("backup-tap：create 202 受理 + 终态帧", () => {
  it("受理即返 {accepted:true}；成功后台发 done 帧无 error", async () => {
    createBackupNowMock.mockResolvedValue({ fileSize: 1, sha256: "x" });
    published.length = 0;
    const face = makeFace("conn-1");
    const result = await face.create("周末备份");
    expect(result).toEqual({ accepted: true });
    expect(createBackupNowMock).toHaveBeenCalledWith(
      "conn-1",
      "周末备份",
      expect.anything(),
      expect.anything(),
    );
    await vi.waitFor(() => {
      const done = published.filter(
        (e) =>
          e.type === "backup.progress" &&
          (e.payload as { done?: boolean }).done,
      );
      expect(done).toHaveLength(1);
      expect((done[0].payload as { error?: string }).error).toBeUndefined();
    });
  });

  it("失败终态帧携 error", async () => {
    createBackupNowMock.mockRejectedValue(new Error("上传超时"));
    published.length = 0;
    await makeFace("conn-1").create(undefined);
    await vi.waitFor(() => {
      const done = published.filter(
        (e) => (e.payload as { done?: boolean }).done,
      );
      expect(done).toHaveLength(1);
      expect((done[0].payload as { error?: string }).error).toBe("上传超时");
    });
  });
});

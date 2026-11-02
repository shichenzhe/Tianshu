/**
 * workspace/query 直查过滤单测（2026-11-02 报障修复）：装配层 workspaces.list
 * （ipc.ts 内联 prisma 直查）where 须含 projectId:null——项目资产空间不进
 * 分组树（对齐桌面 listWorkspaces 语义）。face 侧 HD-A1 装配时漏配曾致
 * 资产空间透出、移动端项目会话同时落 workspace 组与项目组（同 key
 * `r${id}` 重复渲染，React duplicate key 报错）。
 * 依赖经 vi.mock 替换（electron / Log / prisma-client），只取组装产物。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp/ws-list-face") },
  ipcMain: { handle: vi.fn() },
}));

vi.mock("../../../electron/commons/Log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn(async () => []) }));
vi.mock("../../../electron/commons/prisma-client", () => ({
  default: { workspace: { findMany } },
}));

import { faceDeps } from "../../../electron/domains/server-face/deps";
import { attachServerFace } from "../../../electron/domains/server-face/ipc";

describe("workspaces.list 直查过滤（批③报障修复）", () => {
  it("where 含 projectId:null + userId，资产空间行不透出", async () => {
    attachServerFace({} as Parameters<typeof attachServerFace>[0]);
    const workspaces = faceDeps().workspaces;
    expect(workspaces).toBeTruthy();
    await workspaces!.list(7);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 7, projectId: null },
      }),
    );
  });
});

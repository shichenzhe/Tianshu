// A8 工作空间管理批（spec 2026-10-26 §2）：workspace-tap 用例——概要四字段
// 投影（directoryPath 原值透出为既有契约行为）、归属校验（WORKSPACE_NOT_FOUND
// 不泄露存在性）、删除级联语义透传（repo 内聚硬级联：消息→会话→空间）、
// name 空 WORKSPACE_INVALID。内存仓储替身（SessionRepository 结构子集）直测。
import { describe, expect, it } from "vitest";

import {
  createWorkspaceFace,
  type WorkspaceRepoSubset,
} from "../../../electron/domains/server-face/workspace-tap";
import type { WorkspaceRecord } from "../../../src-react/domains/ai/api/workspace.api";

const UID = 7;
const NOW = "2026-10-26T00:00:00.000Z";

function record(overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return {
    id: 1,
    name: "默认工作空间",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/** 内存仓储替身：行带 userId；delete 按桌面 repo 同款硬级联语义模拟
 *  （消息→会话→工作空间行）并记录调用供断言 */
class WorkspaceRepoDouble {
  rows: Array<WorkspaceRecord & { userId: number }>;
  sessions: Array<{ id: number; workspaceId: number; userId: number }>;
  messages: Array<{ id: number; sessionId: number }>;
  lastCreate: unknown = null;
  lastUpdate: unknown = null;
  deletedIds: number[] = [];

  constructor(
    rows: Array<WorkspaceRecord & { userId: number }> = [
      { ...record(), userId: UID },
    ],
  ) {
    this.rows = rows;
    this.sessions = [];
    this.messages = [];
  }

  async createWorkspace(
    p: Record<string, unknown>,
    userId: number,
  ): Promise<WorkspaceRecord> {
    this.lastCreate = { ...p, userId };
    const row = {
      ...record(),
      ...p,
      userId,
    } as WorkspaceRecord & { userId: number };
    this.rows.push(row);
    return row;
  }

  async updateWorkspace(
    p: { id: number; name?: string; icon?: string; defaultModelId?: number },
    userId: number,
  ): Promise<WorkspaceRecord> {
    const row = this.rows.find((r) => r.id === p.id && r.userId === userId);
    if (!row) throw new Error("WORKSPACE_NOT_FOUND");
    this.lastUpdate = { ...p, userId };
    return { ...row, ...p };
  }

  async deleteWorkspace(id: number, userId: number): Promise<void> {
    const row = this.rows.find((r) => r.id === id && r.userId === userId);
    if (!row) throw new Error("WORKSPACE_NOT_FOUND");
    // 桌面 repo 同款硬级联语义：消息→会话→工作空间行
    const sessionIds = this.sessions
      .filter((s) => s.workspaceId === id)
      .map((s) => s.id);
    this.messages = this.messages.filter(
      (m) => !sessionIds.includes(m.sessionId),
    );
    this.sessions = this.sessions.filter((s) => s.workspaceId !== id);
    this.rows = this.rows.filter((r) => r.id !== id);
    this.deletedIds.push(id);
  }
}

function makeFace(rows?: Array<WorkspaceRecord & { userId: number }>) {
  const repo = new WorkspaceRepoDouble(rows);
  const face = createWorkspaceFace(repo as unknown as WorkspaceRepoSubset);
  return { face, repo };
}

describe("workspace-tap（A8 工作空间管理批）", () => {
  it("create：概要四字段投影（directoryPath/defaultModelId 缺省 null），name/icon/defaultModelId 透传 userId 归属", async () => {
    const { face, repo } = makeFace([]);
    const brief = await face.create!(UID, {
      name: " 新空间 ",
      icon: "🚀",
      defaultModelId: 3,
    });
    expect(brief).toEqual({
      id: expect.any(Number),
      name: "新空间",
      directoryPath: null,
      defaultModelId: 3,
    });
    expect(repo.lastCreate).toMatchObject({
      name: "新空间",
      icon: "🚀",
      defaultModelId: 3,
      userId: UID,
    });
  });

  it("create：name 缺省/空串/纯空白拒 WORKSPACE_INVALID", async () => {
    const { face } = makeFace([]);
    for (const payload of [{}, { name: "" }, { name: "   " }]) {
      try {
        await face.create!(UID, payload);
        expect.unreachable();
      } catch (error) {
        expect((error as { code: string }).code).toBe("WORKSPACE_INVALID");
      }
    }
  });

  it("create：未传 icon/defaultModelId 键缺失（repo 缺省语义）", async () => {
    const { face, repo } = makeFace([]);
    await face.create!(UID, { name: "精简" });
    expect(repo.lastCreate).toMatchObject({ name: "精简", userId: UID });
    expect("icon" in (repo.lastCreate as object)).toBe(false);
    expect("defaultModelId" in (repo.lastCreate as object)).toBe(false);
  });

  it("update：全量字段透传（undefined 键缺失保留原值），概要四字段回传", async () => {
    const { face, repo } = makeFace([
      {
        ...record({ directoryPath: "/ws", defaultModelId: 9 }),
        userId: UID,
      },
    ]);
    const brief = await face.update!(UID, {
      id: 1,
      name: "改名",
      defaultModelId: 5,
    });
    expect(brief).toEqual({
      id: 1,
      name: "改名",
      directoryPath: "/ws",
      defaultModelId: 5,
    });
    expect(repo.lastUpdate).toMatchObject({
      id: 1,
      name: "改名",
      defaultModelId: 5,
      userId: UID,
    });
    expect("icon" in (repo.lastUpdate as object)).toBe(false);
  });

  it("update：不存在/他人所有同报 WORKSPACE_NOT_FOUND（不泄露存在性）", async () => {
    const { face } = makeFace([{ ...record(), userId: 99 }]);
    for (const id of [1, 404]) {
      try {
        await face.update!(UID, { id, name: "x" });
        expect.unreachable();
      } catch (error) {
        expect((error as { code: string }).code).toBe("WORKSPACE_NOT_FOUND");
      }
    }
  });

  it("update：name 空串/纯空白拒 WORKSPACE_INVALID", async () => {
    const { face } = makeFace();
    for (const name of ["", "   "]) {
      try {
        await face.update!(UID, { id: 1, name });
        expect.unreachable();
      } catch (error) {
        expect((error as { code: string }).code).toBe("WORKSPACE_INVALID");
      }
    }
  });

  it("remove：删除级联语义（消息→会话→工作空间行）由 repo 内聚执行", async () => {
    const { face, repo } = makeFace();
    repo.sessions.push(
      { id: 11, workspaceId: 1, userId: UID },
      { id: 12, workspaceId: 1, userId: UID },
      { id: 13, workspaceId: 2, userId: UID },
    );
    repo.messages.push(
      { id: 101, sessionId: 11 },
      { id: 102, sessionId: 12 },
      { id: 103, sessionId: 13 },
    );
    await face.remove!(UID, 1);
    expect(repo.deletedIds).toEqual([1]);
    // 空间 1 的会话/消息清掉；空间 2 的会话 13/消息 103 保留
    expect(repo.sessions.map((s) => s.id)).toEqual([13]);
    expect(repo.messages.map((m) => m.id)).toEqual([103]);
    expect(repo.rows.find((r) => r.id === 1)).toBeUndefined();
  });

  it("remove：不存在/他人所有同报 WORKSPACE_NOT_FOUND", async () => {
    const { face } = makeFace([{ ...record(), userId: 99 }]);
    for (const id of [1, 404]) {
      try {
        await face.remove!(UID, id);
        expect.unreachable();
      } catch (error) {
        expect((error as { code: string }).code).toBe("WORKSPACE_NOT_FOUND");
      }
    }
  });

  it("未知 repo 错误原样抛出（routes 5000 兜底，不冒充稳定码）", async () => {
    const repo = new WorkspaceRepoDouble();
    repo.deleteWorkspace = async () => {
      throw new Error("SOME_UNKNOWN_FAILURE");
    };
    const face = createWorkspaceFace(repo as unknown as WorkspaceRepoSubset);
    try {
      await face.remove!(UID, 1);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("SOME_UNKNOWN_FAILURE");
      expect((error as { code?: string }).code).toBeUndefined();
    }
  });
});

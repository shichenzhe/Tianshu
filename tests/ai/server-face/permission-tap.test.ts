// A10 审批记忆管理批（spec 2026-10-26 §2）：permission-tap 用例——五段桥
// 纯信封语义：userId 透传归属、revokeAll 计数信封 {revoked}、full  grants
// {grants} 信封、id 形态守卫 PERMISSION_INVALID（单条撤销幂等 no-op 语义
// 在 ChatService 内聚，tap 无 NOT_FOUND 路径）。内存 ChatService 替身
//（PermissionChatSubset 结构子集）直测。
import { describe, expect, it } from "vitest";

import type {
  PermissionFullGrantItem,
  PermissionRememberedItem,
} from "@tianshu/protocol";
import {
  createPermissionFace,
  FacePermissionError,
  type PermissionChatSubset,
} from "../../../electron/domains/server-face/permission-tap";

const UID = 7;
const NOW = "2026-10-26T00:00:00.000Z";

/** 内存 ChatService 替身：记录调用 + 可控返回值（结构子集语义） */
class ChatDouble {
  calls: Array<{ method: string; args: unknown[] }> = [];
  remembered: PermissionRememberedItem[] = [];
  revokeSingleResult: void = undefined;
  revokeAllCount = 0;
  fullGrants: PermissionFullGrantItem[] = [];
  revokeAllFullCount = 0;

  async listRemembered(userId: number): Promise<PermissionRememberedItem[]> {
    this.calls.push({ method: "listRemembered", args: [userId] });
    return this.remembered;
  }

  async revokeRemembered(id: number, userId: number): Promise<void> {
    this.calls.push({ method: "revokeRemembered", args: [id, userId] });
    return this.revokeSingleResult;
  }

  async revokeAllRemembered(userId: number): Promise<number> {
    this.calls.push({ method: "revokeAllRemembered", args: [userId] });
    return this.revokeAllCount;
  }

  async listFullGrants(): Promise<PermissionFullGrantItem[]> {
    this.calls.push({ method: "listFullGrants", args: [] });
    return this.fullGrants;
  }

  revokeAllFull(): number {
    this.calls.push({ method: "revokeAllFull", args: [] });
    return this.revokeAllFullCount;
  }
}

function faceOf(double: ChatDouble) {
  return createPermissionFace(double as unknown as PermissionChatSubset);
}

describe("permission-tap（A10 审批记忆批）", () => {
  it("listRemembered：userId 透传，行形状原样信封（id/workspaceName/toolName/createdAt）", async () => {
    const double = new ChatDouble();
    double.remembered = [
      {
        id: 3,
        workspaceName: "默认工作空间",
        toolName: "write_file",
        createdAt: NOW,
      },
      { id: 1, workspaceName: "#9", toolName: "bash", createdAt: NOW },
    ];
    const face = faceOf(double);
    const rows = await face.listRemembered(UID);
    expect(rows).toEqual(double.remembered);
    expect(double.calls).toEqual([{ method: "listRemembered", args: [UID] }]);
  });

  it("revokeRemembered：正整数 id 透传 (id, userId)，返回 null（幂等 no-op 语义在 service）", async () => {
    const double = new ChatDouble();
    const face = faceOf(double);
    await expect(face.revokeRemembered(UID, 42)).resolves.toBeNull();
    expect(double.calls).toEqual([
      { method: "revokeRemembered", args: [42, UID] },
    ]);
  });

  it("revokeRemembered：id 形态非法（0/负数/非整数）→ PERMISSION_INVALID，不触 service", async () => {
    const double = new ChatDouble();
    const face = faceOf(double);
    for (const id of [0, -3, 1.5]) {
      await expect(face.revokeRemembered(UID, id)).rejects.toMatchObject({
        code: "PERMISSION_INVALID",
      });
    }
    expect(double.calls).toEqual([]);
    // FacePermissionError 实例 + code 稳定
    const error = await face.revokeRemembered(UID, 0).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FacePermissionError);
  });

  it("revokeAllRemembered：service 计数 → {revoked} 信封（空集 0 语义透传）", async () => {
    const double = new ChatDouble();
    double.revokeAllCount = 5;
    const face = faceOf(double);
    await expect(face.revokeAllRemembered(UID)).resolves.toEqual({
      revoked: 5,
    });
    expect(double.calls).toEqual([
      { method: "revokeAllRemembered", args: [UID] },
    ]);
  });

  it("listFullGrants：{grants} 信封（{sessionId,title} 形状，无 toolName/createdAt）", async () => {
    const double = new ChatDouble();
    double.fullGrants = [
      { sessionId: 11, title: "会话 #11" },
      { sessionId: 4, title: "改造计划" },
    ];
    const face = faceOf(double);
    await expect(face.listFullGrants(UID)).resolves.toEqual({
      grants: [
        { sessionId: 11, title: "会话 #11" },
        { sessionId: 4, title: "改造计划" },
      ],
    });
    expect(double.calls).toEqual([{ method: "listFullGrants", args: [] }]);
  });

  it("revokeAllFull：service 计数 → {revoked} 信封", async () => {
    const double = new ChatDouble();
    double.revokeAllFullCount = 2;
    const face = faceOf(double);
    await expect(face.revokeAllFull(UID)).resolves.toEqual({ revoked: 2 });
    expect(double.calls).toEqual([{ method: "revokeAllFull", args: [] }]);
  });
});

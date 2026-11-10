/**
 * ServerApi 会话写面 wire 形状锁定（2026-11-09 远程删除报「会话不存在」
 * 修复随批）：sessionDelete 此前发 {sessionId}，而两端被控端（桌面 face
 * handleDelete 读 body.id、无头端 SessionIdDto.id）都期待 {id}——asInt
 * (undefined)=null 直接 4040「会话不存在」，请求到端但载荷解不出 id。
 * 本测试 mock @/lib/ipc 的 invoke，把各 session 写端点的 wire 形状逐字
 * 锁死（跨段终验清单「载荷字段接线」项——层间 mock（session-route.test）
 * 断言不到 wire 层，错位即由此漏网）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", () => ({
  invoke: invokeMock,
  on: vi.fn(),
}));

import ServerApi from "../../../src-react/domains/ai/server/api/server.api";

const OK_ENVELOPE = {
  status: 200,
  body: { code: "2000", success: true, data: null, message: "success" },
};

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(OK_ENVELOPE);
});

describe("session 写面 wire 形状（两端被控端契约锁定）", () => {
  it("delete 发 {id}——face handleDelete 与无头端 SessionIdDto 均读 id", async () => {
    await ServerApi.sessionDelete(9, "c1");
    expect(invokeMock).toHaveBeenCalledWith(
      "server:sessionDelete",
      { id: 9 },
      "c1",
    );
  });

  it("abort/update/read/create 维持 {sessionId} 契约（两端同名字段）", async () => {
    await ServerApi.sessionAbort(9, "c1");
    expect(invokeMock).toHaveBeenLastCalledWith(
      "server:sessionAbort",
      { sessionId: 9 },
      "c1",
    );

    await ServerApi.sessionUpdate(9, { title: "改名" }, "c1");
    expect(invokeMock).toHaveBeenLastCalledWith(
      "server:sessionUpdate",
      { sessionId: 9, title: "改名" },
      "c1",
    );

    await ServerApi.sessionCreate({ title: "新会话" }, "c1");
    expect(invokeMock).toHaveBeenLastCalledWith(
      "server:sessionCreate",
      { title: "新会话" },
      "c1",
    );
  });

  it("workspace 写面：create/update 载荷直传、delete 发 {id}（对齐 face parseWorkspaceSavePayload）", async () => {
    const brief = {
      id: 3,
      name: "空间",
      directoryPath: null,
      defaultModelId: null,
    };
    invokeMock.mockResolvedValue({
      status: 200,
      body: { code: "2000", success: true, data: brief, message: "success" },
    });

    await ServerApi.workspaceCreate({ name: "空间" }, "c1");
    expect(invokeMock).toHaveBeenLastCalledWith(
      "server:workspaceCreate",
      { name: "空间" },
      "c1",
    );

    await ServerApi.workspaceUpdate({ id: 3, name: "改名" }, "c1");
    expect(invokeMock).toHaveBeenLastCalledWith(
      "server:workspaceUpdate",
      { id: 3, name: "改名" },
      "c1",
    );

    await ServerApi.workspaceDelete(3, "c1");
    expect(invokeMock).toHaveBeenLastCalledWith(
      "server:workspaceDelete",
      { id: 3 },
      "c1",
    );
  });
});

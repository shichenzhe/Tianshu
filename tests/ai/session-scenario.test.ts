import { describe, expect, it, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ invoke: invokeMock }));

import SessionApi from "@/domains/ai/api/session.api";

describe("session:create scenario 透传", () => {
  beforeEach(() => invokeMock.mockReset());

  it("带 scenario 创建会话", async () => {
    invokeMock.mockResolvedValue({ id: 1, workspaceId: 2, title: "x", mode: "agent" });
    await SessionApi.create({ workspaceId: 2, scenario: "coding" });
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith("session:create", {
      workspaceId: 2,
      scenario: "coding",
    });
  });

  it("不传 scenario 字段不出现", async () => {
    invokeMock.mockResolvedValue({ id: 1, workspaceId: 2, title: "x", mode: "agent" });
    await SessionApi.create({ workspaceId: 2 });
    expect(invokeMock.mock.calls[0][1]).toEqual({ workspaceId: 2 });
  });
});

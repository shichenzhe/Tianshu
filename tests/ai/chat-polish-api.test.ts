import { describe, expect, it, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ invoke: invokeMock }));

import ChatApi, { type PolishStyle } from "@/domains/ai/api/chat.api";

describe("ChatApi.polish", () => {
  beforeEach(() => invokeMock.mockReset());

  it("透传 workspaceId/text/style", async () => {
    invokeMock.mockResolvedValue({ text: "polished" });
    const style: PolishStyle = "concise";
    await ChatApi.polish({ workspaceId: 3, text: "draft", style });
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith("chat:polish", {
      workspaceId: 3,
      text: "draft",
      style: "concise",
    });
  });
});

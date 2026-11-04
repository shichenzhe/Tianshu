// tests/ai/read-external-file.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ invoke: invokeMock }));

import { readExternalFile } from "@/domains/ai/new-task/lib/attach";

describe("readExternalFile", () => {
  beforeEach(() => invokeMock.mockReset());

  it("透传绝对路径到 file:readExternalFile", async () => {
    invokeMock.mockResolvedValue({ kind: "text", content: "hi", size: 2 });
    const out = await readExternalFile("/tmp/a.md");
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith(
      "file:readExternalFile",
      "/tmp/a.md",
    );
    expect(out).toEqual({ kind: "text", content: "hi", size: 2 });
  });
});

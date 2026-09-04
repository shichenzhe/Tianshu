import { describe, expect, it } from "vitest";
import { canRemember } from "../../src-react/domains/ai/lib/can-remember";

describe("canRemember（MCP 审批横幅门控）", () => {
  it("文件类 write 工具可记住", () => {
    expect(canRemember("write_file")).toBe(true);
  });

  it("MCP 工具不可记住（不吃工作空间写授权）", () => {
    expect(canRemember("mcp__server__tool")).toBe(false);
  });
});

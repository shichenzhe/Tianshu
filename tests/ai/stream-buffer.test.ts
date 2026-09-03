import { describe, expect, it } from "vitest";
import { StreamBuffer } from "../../src-react/domains/ai/chat/store/stream-buffer";

describe("StreamBuffer 节流", () => {
  it("间隔内累积不输出", () => {
    const b = new StreamBuffer(30);
    expect(b.push("a", 0)).toBeNull();
    expect(b.push("b", 10)).toBeNull();
  });

  it("超过间隔输出累积内容", () => {
    const b = new StreamBuffer(30);
    b.push("a", 0);
    b.push("b", 10);
    expect(b.flush(31)).toBe("ab");
  });

  it("间隔到了 push 直接输出", () => {
    const b = new StreamBuffer(30);
    b.push("a", 0);
    expect(b.push("b", 40)).toBe("ab");
  });

  it("flush 后重新累积", () => {
    const b = new StreamBuffer(30);
    b.push("a", 0);
    expect(b.flush(1)).toBe("a");
    b.push("b", 2);
    expect(b.flush(3)).toBe("b");
  });
});

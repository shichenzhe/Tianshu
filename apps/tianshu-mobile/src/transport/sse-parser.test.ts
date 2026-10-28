import { describe, expect, it, vi } from "vitest";
import { createSseParser } from "./sse-parser";

describe("createSseParser", () => {
  it("完整事件一次吐出（无 event 行 → undefined）", () => {
    const onFrame = vi.fn();
    const p = createSseParser(onFrame);
    p('data: {"a":1}\n\n');
    expect(onFrame).toHaveBeenCalledWith({ event: undefined, data: '{"a":1}' });
  });

  it("半包行跨 chunk 拼接", () => {
    const onFrame = vi.fn();
    const p = createSseParser(onFrame);
    p('data: {"a"');
    p(':1}\n\n');
    expect(onFrame).toHaveBeenCalledExactlyOnceWith({
      event: undefined,
      data: '{"a":1}',
    });
  });

  it("多 data: 行以 \\n 拼接（SSE 规范）", () => {
    const onFrame = vi.fn();
    const p = createSseParser(onFrame);
    p("data: line1\ndata: line2\n\n");
    expect(onFrame).toHaveBeenCalledWith({
      event: undefined,
      data: "line1\nline2",
    });
  });

  it("注释心跳行与空行不打扰", () => {
    const onFrame = vi.fn();
    const p = createSseParser(onFrame);
    p(": ping\n\n");
    expect(onFrame).not.toHaveBeenCalled();
  });

  it("CRLF 行尾归一", () => {
    const onFrame = vi.fn();
    const p = createSseParser(onFrame);
    p('data: {"a":1}\r\n\r\n');
    expect(onFrame).toHaveBeenCalledWith({ event: undefined, data: '{"a":1}' });
  });

  it("event: 行透出帧类型（被控端 SSE 帧格式）", () => {
    const onFrame = vi.fn();
    const p = createSseParser(onFrame);
    p('event: session.updated\ndata: {"id":1}\n\n');
    expect(onFrame).toHaveBeenCalledExactlyOnceWith({
      event: "session.updated",
      data: '{"id":1}',
    });
  });

  it("event 行与 data 行跨 chunk 半包", () => {
    const onFrame = vi.fn();
    const p = createSseParser(onFrame);
    p("event: messa");
    p('ge.chunk\ndata: {"b"');
    p(':2}\n\n');
    expect(onFrame).toHaveBeenCalledExactlyOnceWith({
      event: "message.chunk",
      data: '{"b":2}',
    });
  });
});

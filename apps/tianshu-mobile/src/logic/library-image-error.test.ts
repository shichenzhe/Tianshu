import { describe, expect, it } from "vitest";

import {
  imageFailureKey,
  libraryErrorCodeOf,
  writeFailureKey,
} from "./library-image-error";

describe("libraryErrorCodeOf", () => {
  it("取 error.code 字符串", () => {
    const error = new Error("文件过大");
    (error as { code?: string }).code = "LIBRARY_TOO_LARGE";
    expect(libraryErrorCodeOf(error)).toBe("LIBRARY_TOO_LARGE");
  });

  it("无 code/非对象/空串 → null", () => {
    expect(libraryErrorCodeOf(new Error("x"))).toBeNull();
    expect(libraryErrorCodeOf("LIBRARY_BINARY")).toBeNull();
    expect(libraryErrorCodeOf(null)).toBeNull();
    expect(
      libraryErrorCodeOf({ code: "" } satisfies { code: string }),
    ).toBeNull();
  });
});

describe("imageFailureKey 错误码映射", () => {
  it("LIBRARY_TOO_LARGE → errorTooLarge（10MB 上限独立文案）", () => {
    expect(imageFailureKey("LIBRARY_TOO_LARGE")).toBe("errorTooLarge");
  });

  it("LIBRARY_BINARY → errorBinary（二进制守卫独立文案）", () => {
    expect(imageFailureKey("LIBRARY_BINARY")).toBe("errorBinary");
  });

  it("其它码与无码回落 imageFailed（笼统加载失败）", () => {
    expect(imageFailureKey("LIBRARY_READ_FAILED")).toBe("imageFailed");
    expect(imageFailureKey("NETWORK")).toBe("imageFailed");
    expect(imageFailureKey(null)).toBe("imageFailed");
  });
});

describe("writeFailureKey 内容写错误码映射（资料库编辑批）", () => {
  it("LIBRARY_TOO_LARGE → errorWriteTooLarge（512KiB 写守卫独立文案）", () => {
    expect(writeFailureKey("LIBRARY_TOO_LARGE")).toBe("errorWriteTooLarge");
  });

  it("LIBRARY_WRITE_FAILED 与其余无码回落 errorWriteFailed", () => {
    expect(writeFailureKey("LIBRARY_WRITE_FAILED")).toBe("errorWriteFailed");
    expect(writeFailureKey("LIBRARY_READ_FAILED")).toBe("errorWriteFailed");
    expect(writeFailureKey(null)).toBe("errorWriteFailed");
  });
});

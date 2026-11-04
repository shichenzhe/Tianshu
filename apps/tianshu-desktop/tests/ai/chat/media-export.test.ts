/**
 * media-export（dataUrl 图片另存为纯函数）单测：
 * - parseImageDataUrl：合法解码 / 格式非法 / mime 白名单外 / 超上限
 * - sanitizeSaveName：目录剥离 + 非法字符剔除 + 扩展强制改写
 * - saveImageDataUrl：无扩展补齐 + 字节落盘（tmp 目录）
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  IMAGE_SAVE_LIMIT_BYTES,
  parseImageDataUrl,
  sanitizeSaveName,
  saveImageDataUrl,
} from "../../../electron/domains/ai/chat/media-export";

const tmpRoot = path.join(os.tmpdir(), "tianshu-media-export-test");
afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("parseImageDataUrl", () => {
  it("合法 png dataUrl 解出 mime/扩展/字节", () => {
    const base64 = Buffer.from("fakepng").toString("base64");
    const parsed = parseImageDataUrl(`data:image/png;base64,${base64}`);
    expect(parsed.mime).toBe("image/png");
    expect(parsed.ext).toBe("png");
    expect(parsed.buffer.toString()).toBe("fakepng");
  });

  it("非法格式（非 data: 前缀 / 非 base64）抛 IMAGE_DATAURL_INVALID", () => {
    expect(() => parseImageDataUrl("http://x/a.png")).toThrow(
      "IMAGE_DATAURL_INVALID",
    );
    expect(() => parseImageDataUrl("data:image/png;base64,!!!")).toThrow(
      "IMAGE_DATAURL_INVALID",
    );
  });

  it("mime 白名单外（svg）抛 IMAGE_DATAURL_MIME_REJECTED；非 image dataUrl 抛 INVALID", () => {
    const base64 = Buffer.from("x").toString("base64");
    expect(() =>
      parseImageDataUrl(`data:image/svg+xml;base64,${base64}`),
    ).toThrow("IMAGE_DATAURL_MIME_REJECTED");
    // text/plain 连 image/ 前缀都没有，属格式非法而非白名单拒绝
    expect(() => parseImageDataUrl(`data:text/plain;base64,${base64}`)).toThrow(
      "IMAGE_DATAURL_INVALID",
    );
  });

  it("超 10MB 上限抛 IMAGE_DATAURL_TOO_LARGE", () => {
    const big = Buffer.alloc(IMAGE_SAVE_LIMIT_BYTES + 1, 1).toString("base64");
    expect(() => parseImageDataUrl(`data:image/png;base64,${big}`)).toThrow(
      "IMAGE_DATAURL_TOO_LARGE",
    );
  });
});

describe("sanitizeSaveName", () => {
  it("剥离目录与非法字符，强制白名单扩展", () => {
    expect(sanitizeSaveName("../../etc/passwd", "png")).toBe("passwd.png");
    // ASCII 非法字符剔除、中文等合法字符保留
    expect(sanitizeSaveName('chart:<坏>"名?.png', "png")).toBe("chart坏名.png");
    expect(sanitizeSaveName("photo.jpeg", "png")).toBe("photo.png");
  });

  it("空名/纯扩展回退 image 兜底", () => {
    expect(sanitizeSaveName("", "png")).toBe("image.png");
    expect(sanitizeSaveName(".png", "png")).toBe("image.png");
  });
});

describe("saveImageDataUrl", () => {
  it("无扩展补齐 mime 扩展并落盘字节；返回最终路径", async () => {
    const dataUrl = `data:image/png;base64,${Buffer.from("bytes-here").toString("base64")}`;
    const target = path.join(tmpRoot, "sub", "exported");
    const finalPath = await saveImageDataUrl(dataUrl, target);
    expect(finalPath).toBe(`${target}.png`);
    expect((await fs.readFile(finalPath)).toString()).toBe("bytes-here");
  });

  it("已有扩展尊重用户选择（不追加）", async () => {
    const dataUrl = `data:image/png;base64,${Buffer.from("x").toString("base64")}`;
    const target = path.join(tmpRoot, "chosen.bin");
    expect(await saveImageDataUrl(dataUrl, target)).toBe(target);
  });
});

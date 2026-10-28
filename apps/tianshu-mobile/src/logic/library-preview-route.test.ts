import { describe, expect, it } from "vitest";

import { extensionOf, previewRouteOf } from "./library-preview-route";

function item(
  name: string,
  fileType: string | null = null,
  kind: "folder" | "file" | "link" = "file",
) {
  return { kind, fileType, name };
}

describe("extensionOf", () => {
  it("常规扩展名转小写", () => {
    expect(extensionOf("报表.CSV")).toBe("csv");
    expect(extensionOf("a.b.PNG")).toBe("png");
  });

  it("无扩展名/点文件返回空串", () => {
    expect(extensionOf("README")).toBe("");
    expect(extensionOf(".gitignore")).toBe("");
    expect(extensionOf("file.")).toBe("");
  });
});

describe("previewRouteOf 分流", () => {
  it("html/htm（大小写不敏感）→ text（FilePreviewModal WebView 分支）", () => {
    expect(previewRouteOf(item("页.html"))).toEqual({ kind: "text" });
    expect(previewRouteOf(item("页.HTM"))).toEqual({ kind: "text" });
  });

  it("csv（大小写不敏感）→ csv 表格预览", () => {
    expect(previewRouteOf(item("数据.csv"))).toEqual({ kind: "csv" });
    expect(previewRouteOf(item("数据.CSV"))).toEqual({ kind: "csv" });
  });

  it("markdown/text/code fileType → text", () => {
    expect(previewRouteOf(item("笔记.md", "markdown"))).toEqual({
      kind: "text",
    });
    expect(previewRouteOf(item("说明.txt", "text"))).toEqual({
      kind: "text",
    });
    expect(previewRouteOf(item("脚本.ts", "code"))).toEqual({
      kind: "text",
    });
  });

  it("五型图片（大小写不敏感）→ image", () => {
    for (const ext of ["png", "jpg", "jpeg", "webp", "gif"]) {
      expect(previewRouteOf(item(`图.${ext}`, "image"))).toEqual({
        kind: "image",
      });
    }
    expect(previewRouteOf(item("图.PNG", "image"))).toEqual({
      kind: "image",
    });
  });

  it("svg → svg（readImage + WebView data URL）", () => {
    expect(previewRouteOf(item("图标.svg", "image"))).toEqual({
      kind: "svg",
    });
    expect(previewRouteOf(item("图标.SVG", "image"))).toEqual({
      kind: "svg",
    });
  });

  it("bmp/ico → desktop（前置拦截不发请求）", () => {
    expect(previewRouteOf(item("图.bmp", "image"))).toEqual({
      kind: "desktop",
    });
    expect(previewRouteOf(item("图.ICO", "image"))).toEqual({
      kind: "desktop",
    });
  });

  it("未知图片扩展名/无扩展名 → desktop", () => {
    expect(previewRouteOf(item("图.tiff", "image"))).toEqual({
      kind: "desktop",
    });
    expect(previewRouteOf(item("图", "image"))).toEqual({
      kind: "desktop",
    });
  });

  it("未知 fileType 且非 html/csv 扩展名 → desktop", () => {
    expect(previewRouteOf(item("片.mp4", "video"))).toEqual({
      kind: "desktop",
    });
    expect(previewRouteOf(item("曲.mp3", null))).toEqual({
      kind: "desktop",
    });
  });

  it("folder/link 防御性归 desktop（调用方先行截走）", () => {
    expect(previewRouteOf(item("夹", null, "folder"))).toEqual({
      kind: "desktop",
    });
    expect(previewRouteOf(item("链", null, "link"))).toEqual({
      kind: "desktop",
    });
  });
});

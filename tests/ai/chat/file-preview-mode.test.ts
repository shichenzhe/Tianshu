/**
 * 产物面板按类型预览的模式判定测试：webview/图片/md/文本矩阵与口径对齐
 *（webview 集 = 后端 WEBVIEW_EXTS；图片集 = 后端 IMAGE_MIME；md 细分）
 */
import { describe, expect, it } from "vitest";

import { previewModeOfPath } from "../../../src-react/domains/ai/chat/lib/file-preview-mode";

describe("previewModeOfPath", () => {
  it("webview 类：html/pdf/音视频（大小写不敏感）", () => {
    for (const p of [
      "a.html",
      "b.htm",
      "c.pdf",
      "d.mp3",
      "e.wav",
      "f.ogg",
      "g.m4a",
      "h.flac",
      "i.mp4",
      "j.mov",
      "k.avi",
      "l.mkv",
      "m.webm",
      "N.PDF",
    ]) {
      expect(previewModeOfPath(p)).toBe("webview");
    }
  });

  it("图片类与后端 dataUrl 通道口径一致（png/jpg/jpeg/gif/webp/svg）", () => {
    for (const p of ["x.png", "x.jpg", "x.jpeg", "x.gif", "x.webp", "x.svg"]) {
      expect(previewModeOfPath(p)).toBe("image");
    }
  });

  it("md/markdown 走 Markdown 渲染；其余（含代码/无扩展名）归文本", () => {
    expect(previewModeOfPath("readme.md")).toBe("md");
    expect(previewModeOfPath("note.markdown")).toBe("md");
    expect(previewModeOfPath("main.ts")).toBe("text");
    expect(previewModeOfPath("data.json")).toBe("text");
    expect(previewModeOfPath("LICENSE")).toBe("text");
    expect(previewModeOfPath("dir/readme.md")).toBe("md");
  });
});

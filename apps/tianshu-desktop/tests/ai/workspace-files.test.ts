/**
 * 工作空间文件读取测试:文本/图片 dataUrl/二进制/ENOENT/超限/路径 resolve
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  imageAttachmentBlocks,
  readImageAsDataUrl,
  readWorkspaceFile,
  resolveFilePath,
  stageImageIntoAttachments,
} from "../../electron/domains/ai/chat/workspace-files";

const base = await mkdtemp(path.join(tmpdir(), "ws-files-"));
// 图片通道用例共用子目录（describe 回调须同步，目录在模块顶层建好）
await mkdir(path.join(base, "attachments"), { recursive: true });
await mkdir(path.join(base, "library"), { recursive: true });
// 数据根外的空间目录（收编用例：空间绑定目录可在任意位置）
const wsOutsideDir = await mkdtemp(path.join(tmpdir(), "ws-outside-"));
afterAll(async () => {
  await writeFile(path.join(base, ".keep"), "");
});

describe("resolveFilePath", () => {
  it("相对路径以工作空间为基", () => {
    expect(resolveFilePath("/tmp/ws", "a/b.ts")).toBe(
      path.resolve("/tmp/ws", "a/b.ts"),
    );
  });
  it("绝对路径直接 resolve（fullAccess 语义）", () => {
    expect(resolveFilePath("/tmp/ws", "/etc/hosts")).toBe(
      path.resolve("/etc/hosts"),
    );
  });
});

describe("readWorkspaceFile", () => {
  it("文本文件返回全文 + 磁盘 mtime（文件窗保存基线）", async () => {
    const p = path.join(base, "a.md");
    await writeFile(p, "# hi");
    const r = await readWorkspaceFile(p);
    expect(r).toEqual({
      kind: "text",
      content: "# hi",
      size: 4,
      mtime: expect.any(Number),
    });
    expect(r.mtime).toBeGreaterThan(0);
  });

  it("图片转 base64 dataUrl（含 mtime）", async () => {
    const p = path.join(base, "logo.png");
    await writeFile(p, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const r = await readWorkspaceFile(p);
    expect(r.kind).toBe("image");
    expect(r.dataUrl).toBe("data:image/png;base64,iVBORw==");
    expect(r.mtime).toBeGreaterThan(0);
  });

  it("真实 PNG（含 NUL 字节）按扩展名返回 image", async () => {
    const p = path.join(base, "real.png");
    await writeFile(
      p,
      Buffer.from([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a, // PNG 签名
        0x00,
        0x00,
        0x00,
        0x0d, // IHDR 长度字段（含 NUL）
        0x49,
        0x48,
        0x44,
        0x52, // "IHDR"
      ]),
    );
    const r = await readWorkspaceFile(p);
    expect(r.kind).toBe("image");
    expect(r.dataUrl).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/);
  });

  it("ENOENT 抛中文文案", async () => {
    await expect(readWorkspaceFile(path.join(base, "nope"))).rejects.toThrow(
      "文件不存在",
    );
  });

  it("webview 类（html/pdf/音视频）返回绝对路径，不读内容、不受 512KB 上限", async () => {
    for (const name of ["doc.html", "report.pdf", "clip.mp4", "track.flac"]) {
      const p = path.join(base, name);
      // 超 512KB 的假字节：webview 分支在读取上限检查之前返回
      await writeFile(p, Buffer.alloc(600 * 1024, 1));
      const r = await readWorkspaceFile(p);
      expect(r.kind).toBe("webview");
      expect(r.absPath).toBe(p);
      expect(r.size).toBe(600 * 1024);
      expect(r.mtime).toBeGreaterThan(0);
    }
  });

  it("webview 类不存在同样抛中文文案（stat 校验在前）", async () => {
    await expect(
      readWorkspaceFile(path.join(base, "nope.pdf")),
    ).rejects.toThrow("文件不存在");
  });

  it("目录抛中文文案", async () => {
    await mkdir(path.join(base, "dir"), { recursive: true });
    await expect(readWorkspaceFile(path.join(base, "dir"))).rejects.toThrow(
      "目标是目录，无法预览",
    );
  });

  it("NUL 二进制抛不支持预览", async () => {
    const p = path.join(base, "bin.dat");
    await writeFile(p, Buffer.from([0x00, 0x01]));
    await expect(readWorkspaceFile(p)).rejects.toThrow(
      "该格式暂不支持预览，请另存查看",
    );
  });

  it("超过 512KB 抛上限", async () => {
    const p = path.join(base, "big.txt");
    await writeFile(p, "a".repeat(512 * 1024 + 1));
    await expect(readWorkspaceFile(p)).rejects.toThrow(
      "文件超过 512KB 预览上限",
    );
  });

  it("图片超 512KB 但未超 10MB 放行（多模态附件通道）", async () => {
    const p = path.join(base, "big.png");
    await writeFile(p, Buffer.alloc(600 * 1024, 1));
    const r = await readWorkspaceFile(p);
    expect(r.kind).toBe("image");
  });

  it("图片超 10MB 抛图片上限", async () => {
    const p = path.join(base, "huge.png");
    await writeFile(p, Buffer.alloc(10 * 1024 * 1024 + 1, 1));
    await expect(readWorkspaceFile(p)).rejects.toThrow("图片超过 10MB 上限");
  });
});

describe("readImageAsDataUrl（消息图片块读取通道）", () => {
  const attachDir = path.join(base, "attachments");

  it("根内图片 → dataUrl", async () => {
    const p = path.join(attachDir, "a.png");
    await writeFile(p, Buffer.from([0x89, 0x50]));
    const url = await readImageAsDataUrl(base, "attachments/a.png");
    expect(url).toBe("data:image/png;base64,iVA=");
  });

  it("相对路径 ../ 越出数据根返回 null", async () => {
    expect(await readImageAsDataUrl(base, "../outside.png")).toBeNull();
  });

  it("文件缺失返回 null（不抛错）", async () => {
    expect(await readImageAsDataUrl(base, "attachments/gone.png")).toBeNull();
  });

  it("未收录扩展名返回 null", async () => {
    const p = path.join(base, "attachments", "a.exe");
    await writeFile(p, Buffer.from([0x00]));
    expect(await readImageAsDataUrl(base, "attachments/a.exe")).toBeNull();
  });
});

describe("imageAttachmentBlocks（发送附件 → 消息块）", () => {
  const subDirs = [path.join(base, "attachments"), path.join(base, "library")];

  it("白名单子目录内图片 → ImageBlock（imagePath 相对数据根）", async () => {
    const p = path.join(base, "attachments", "shot.png");
    await writeFile(p, Buffer.from([0x89, 0x50]));
    const blocks = await imageAttachmentBlocks(base, subDirs, [{ absPath: p }]);
    expect(blocks).toEqual([
      {
        type: "image",
        imagePath: `attachments${path.sep}shot.png`,
        mime: "image/png",
        name: "shot.png",
      },
    ]);
  });

  it("白名单外路径降级占位 text 块（安全校验拒）", async () => {
    const blocks = await imageAttachmentBlocks(base, subDirs, [
      { absPath: "/etc/secret.png" },
    ]);
    expect(blocks).toEqual([
      { type: "text", text: "[图片 secret.png 无法读取]" },
    ]);
  });

  it("文件缺失降级占位 text 块（发送不因此失败）", async () => {
    const blocks = await imageAttachmentBlocks(base, subDirs, [
      { absPath: path.join(base, "attachments", "gone.png") },
    ]);
    expect(blocks).toEqual([
      { type: "text", text: "[图片 gone.png 无法读取]" },
    ]);
  });

  it("未收录扩展名降级占位 text 块", async () => {
    const p = path.join(base, "attachments", "pic.bmp");
    await writeFile(p, Buffer.from([0x00]));
    const blocks = await imageAttachmentBlocks(base, subDirs, [{ absPath: p }]);
    expect(blocks).toEqual([{ type: "text", text: "[图片 pic.bmp 无法读取]" }]);
  });

  it("空数组返回空", async () => {
    expect(await imageAttachmentBlocks(base, subDirs, [])).toEqual([]);
  });
});

describe("stageImageIntoAttachments（workspace 图片收编，T11）", () => {
  const attachRoot = path.join(base, "attachments");
  // 与既有 imageAttachmentBlocks describe 同款白名单（收编路径须命中）
  const subDirs = [attachRoot, path.join(base, "library")];

  it("收编进 attachments 根且内容一致（命名 ws- 前缀防碰撞）", async () => {
    const src = path.join(wsOutsideDir, "shot.png");
    await writeFile(src, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const dest = await stageImageIntoAttachments(attachRoot, src);
    expect(dest).not.toBeNull();
    expect(path.dirname(dest!)).toBe(attachRoot);
    expect(path.basename(dest!)).toMatch(/^ws-\d{14}-[0-9a-f]{8}\.png$/);
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(dest!)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    // 收编后路径天然命中 imageAttachmentBlocks 白名单（不再降级占位）
    const blocks = await imageAttachmentBlocks(base, subDirs, [
      { absPath: dest! },
    ]);
    expect(blocks[0]).toMatchObject({
      type: "image",
      name: path.basename(dest!),
    });
  });

  it("未收录扩展名/文件缺失返回 null（调用方保留原路径走降级）", async () => {
    expect(
      await stageImageIntoAttachments(
        attachRoot,
        path.join(wsOutsideDir, "a.exe"),
      ),
    ).toBeNull();
    expect(
      await stageImageIntoAttachments(
        attachRoot,
        path.join(wsOutsideDir, "gone.png"),
      ),
    ).toBeNull();
  });

  it("超 10MB 返回 null", async () => {
    const big = path.join(wsOutsideDir, "huge.png");
    await writeFile(big, Buffer.alloc(10 * 1024 * 1024 + 1, 1));
    expect(await stageImageIntoAttachments(attachRoot, big)).toBeNull();
  });
});

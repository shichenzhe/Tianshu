/**
 * 工作空间文件读取测试:文本/图片 dataUrl/二进制/ENOENT/超限/路径 resolve
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  readWorkspaceFile,
  resolveFilePath,
} from "../../electron/domains/ai/chat/workspace-files";

const base = await mkdtemp(path.join(tmpdir(), "ws-files-"));
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
  it("文本文件返回全文", async () => {
    const p = path.join(base, "a.md");
    await writeFile(p, "# hi");
    const r = await readWorkspaceFile(p);
    expect(r).toEqual({ kind: "text", content: "# hi", size: 4 });
  });

  it("图片转 base64 dataUrl", async () => {
    const p = path.join(base, "logo.png");
    await writeFile(p, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const r = await readWorkspaceFile(p);
    expect(r.kind).toBe("image");
    expect(r.dataUrl).toBe("data:image/png;base64,iVBORw==");
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
});

// tests/ai/pasted-image-store.test.ts
/**
 * 粘贴截图落盘纯函数（仿 workspace-files.ts 纯 Node 模式，vitest 直测）：
 * - base64 解码落盘 attachments 根、返回绝对路径、文件名 paste- 前缀防碰撞
 * - 10MB 上限（PASTED_IMAGE_TOO_LARGE 标记，渲染层映射 toast）
 * - 非法 base64 / 非法扩展归一 png（防路径注入，不信任渲染层文件名）
 */
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PASTED_IMAGE_LIMIT_BYTES,
  savePastedImage,
} from "../../electron/domains/ai/chat/pasted-image-store";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "pasted-img-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("savePastedImage", () => {
  it("base64 落盘、返回根内绝对路径、文件名 paste- 前缀且扩展归一", async () => {
    const pngBase64 = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]).toString("base64");
    const abs = await savePastedImage({
      base64: pngBase64,
      ext: "png",
      rootDir: root,
    });
    expect(path.dirname(abs)).toBe(root);
    const name = path.basename(abs);
    expect(name.startsWith("paste-")).toBe(true);
    expect(name.endsWith(".png")).toBe(true);
    expect((await readFile(abs)).toString("base64")).toBe(pngBase64);
    expect((await readdir(root)).length).toBe(1);
  });

  it("扩展白名单外/含路径分隔符 → 归一 png（不信任渲染层文件名）", async () => {
    const abs = await savePastedImage({
      base64: "aGk=",
      ext: "../../x/jpg",
      rootDir: root,
    });
    expect(path.basename(abs).endsWith(".png")).toBe(true);
    expect(path.dirname(abs)).toBe(root);
  });

  it("无扩展 → png", async () => {
    const abs = await savePastedImage({
      base64: "aGk=",
      ext: "",
      rootDir: root,
    });
    expect(path.basename(abs).endsWith(".png")).toBe(true);
  });

  it("解码后超 10MB → PASTED_IMAGE_TOO_LARGE（含具体大小标记）", async () => {
    const big = Buffer.alloc(PASTED_IMAGE_LIMIT_BYTES + 1).toString("base64");
    await expect(
      savePastedImage({ base64: big, ext: "png", rootDir: root }),
    ).rejects.toThrow(/PASTED_IMAGE_TOO_LARGE/);
  });

  it("非法 base64 → 拒绝且不落盘", async () => {
    await expect(
      savePastedImage({
        base64: "!!!not-base64!!!",
        ext: "png",
        rootDir: root,
      }),
    ).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });
});

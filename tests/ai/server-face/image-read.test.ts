/**
 * readImageWithinRoot（server-face image 端点数据源）直测：真实文件 +
 * 隔离数据根（TIANSHU_DATA_ROOT 借用临时目录，settings.service.test 同款
 * 口径，结束还原），electron app 经 vi.mock 注入（appDataHome 的
 * app.isPackaged 决定 dev 分组）。防穿越/白名单/超限是安全攸关路径——
 * routes 层用例经 deps 替身只钉 null→4040 包装，此处钉真实读盘语义。
 */
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false },
}));

import {
  IMAGE_READ_LIMIT,
  readImageWithinRoot,
} from "../../../electron/domains/ai/chat/workspace-files";

// 隔离数据根：覆盖全局 setup 的 TIANSHU_DATA_ROOT（dev 分组）
const globalSetupRoot = process.env.TIANSHU_DATA_ROOT!;
const testRoot = await fs.mkdtemp(path.join(tmpdir(), "image-read-"));
process.env.TIANSHU_DATA_ROOT = testRoot;
const dataHome = path.join(testRoot, "dev");

afterAll(async () => {
  process.env.TIANSHU_DATA_ROOT = globalSetupRoot;
  await fs.rm(testRoot, { recursive: true, force: true });
});

describe("readImageWithinRoot（server-face image 端点）", () => {
  it("数据根内合法 png：返回 mime + 与磁盘一致的 base64", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    await fs.mkdir(path.join(dataHome, "attachments"), { recursive: true });
    await fs.writeFile(path.join(dataHome, "attachments", "a.png"), bytes);

    await expect(readImageWithinRoot("attachments/a.png")).resolves.toEqual({
      mime: "image/png",
      dataBase64: bytes.toString("base64"),
    });
  });

  it("路径穿越 ../..：越出数据根返回 null（含拼前缀变体）", async () => {
    await expect(readImageWithinRoot("../../x.png")).resolves.toBeNull();
    // 数据根内前缀再穿出（绕过朴素 startsWith 前缀检查的变体）
    await expect(
      readImageWithinRoot("attachments/../../x.png"),
    ).resolves.toBeNull();
  });

  it("绝对路径指向数据根外：即使真实可读 png 也拒绝", async () => {
    const outside = await fs.mkdtemp(path.join(tmpdir(), "image-outside-"));
    try {
      const abs = path.join(outside, "real.png");
      await fs.writeFile(abs, Buffer.from("outside-png"));
      await expect(readImageWithinRoot(abs)).resolves.toBeNull();
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("白名单外扩展名（.txt）：文件存在可读也拒绝", async () => {
    await fs.mkdir(path.join(dataHome, "logs"), { recursive: true });
    await fs.writeFile(path.join(dataHome, "logs", "x.txt"), "text");
    await expect(readImageWithinRoot("logs/x.txt")).resolves.toBeNull();
  });

  it("超 10MB 上限：拒绝（IMAGE_READ_LIMIT 语义）", async () => {
    await fs.mkdir(path.join(dataHome, "attachments"), { recursive: true });
    await fs.writeFile(
      path.join(dataHome, "attachments", "big.png"),
      Buffer.alloc(IMAGE_READ_LIMIT + 1),
    );
    await expect(
      readImageWithinRoot("attachments/big.png"),
    ).resolves.toBeNull();
  });
});

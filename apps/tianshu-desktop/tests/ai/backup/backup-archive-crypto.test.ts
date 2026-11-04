import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BACKUP_ARCHIVE_MAGIC,
  decryptBackupArchive,
  encryptBackupArchive,
  isEncryptedBackupArchive,
} from "../../../packages/tianshu-core/src/backup-archive-crypto";

/** 备份档口令加密（安全审查 2026-11-02 剩余待办 1）：
 *  scrypt 派生 + AES-256-GCM 档级加密；`tsbak:v1:` 自描述头——
 *  旧明文 tar.gz 档零迁移可恢复（嗅探分流）。 */
describe("backup-archive-crypto", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "backup-crypto-"));
  const filePath = (name: string): string => path.join(tmp, name);

  function writePlain(name: string, bytes: Buffer | string): string {
    const p = filePath(name);
    writeFileSync(p, bytes);
    return p;
  }

  const PLAIN = Buffer.concat([
    Buffer.from("LOCAL-ARCHIVE-PLAINTEXT-BYTES\n"),
    Buffer.alloc(1024, 0xab),
  ]);

  it("加密往返：产物带 tsbak:v1: 头；嗅探为密文；同口令解密字节一致", async () => {
    const src = writePlain("roundtrip.tar.gz", PLAIN);
    const dest = filePath("roundtrip.tsbak");
    const { sha256 } = await encryptBackupArchive("正确口令-123", src, dest);
    expect(isEncryptedBackupArchive(dest)).toBe(true);
    expect(readFileSync(dest).subarray(0, 9).toString("utf8")).toBe(
      BACKUP_ARCHIVE_MAGIC,
    );
    // 密文不含明文片段（防「假加密」）
    expect(readFileSync(dest).includes(PLAIN.subarray(0, 27))).toBe(false);
    const out = filePath("roundtrip.dec.tar.gz");
    await decryptBackupArchive("正确口令-123", dest, out);
    expect(readFileSync(out).equals(PLAIN)).toBe(true);
    // 返回的 sha256 是密文档自身哈希（落盘对拍口径）
    expect(sha256).toBe(createHash("sha256").update(readFileSync(dest)).digest("hex"));
  });

  it("同明文同口令两次加密产不同密文（随机 salt/nonce），且各自可解", async () => {
    const src = writePlain("twice.tar.gz", PLAIN);
    const d1 = filePath("twice-1.tsbak");
    const d2 = filePath("twice-2.tsbak");
    await encryptBackupArchive("口令", src, d1);
    await encryptBackupArchive("口令", src, d2);
    expect(readFileSync(d1).equals(readFileSync(d2))).toBe(false);
    for (const d of [d1, d2]) {
      const out = filePath(`${path.basename(d)}.dec`);
      await decryptBackupArchive("口令", d, out);
      expect(readFileSync(out).equals(PLAIN)).toBe(true);
    }
  });

  it("错口令：解密抛「口令错误」语义错（不产出半解密残档）", async () => {
    const src = writePlain("wrong.tar.gz", PLAIN);
    const dest = filePath("wrong.tsbak");
    await encryptBackupArchive("口令A", src, dest);
    const out = filePath("wrong.dec");
    await expect(decryptBackupArchive("口令B", dest, out)).rejects.toThrow(
      /口令错误/,
    );
  });

  it("密文篡改：认证失败抛错（不静默产出损坏明文）", async () => {
    const src = writePlain("tamper.tar.gz", PLAIN);
    const dest = filePath("tamper.tsbak");
    await encryptBackupArchive("口令", src, dest);
    // 翻转密文中部一字节（避开头行）
    const raw = readFileSync(dest);
    raw[raw.length - 100] ^= 0xff;
    const tampered = filePath("tampered.tsbak");
    writeFileSync(tampered, raw);
    const out = filePath("tamper.dec");
    await expect(decryptBackupArchive("口令", tampered, out)).rejects.toThrow(
      /口令错误|损坏/,
    );
  });

  it("明文 tar.gz 嗅探为非密文（gzip 魔数档）", () => {
    const gzipLike = Buffer.concat([
      Buffer.from([0x1f, 0x8b, 0x08, 0x00]),
      Buffer.alloc(512, 7),
    ]);
    const plain = writePlain("plain.tar.gz", gzipLike);
    expect(isEncryptedBackupArchive(plain)).toBe(false);
  });

  it("对密文档调用嗅探+魔数截断边界：短于魔数的文件按非密文", async () => {
    const stub = writePlain("short.bin", Buffer.alloc(4, 1));
    expect(isEncryptedBackupArchive(stub)).toBe(false);
  });

  it("流式多块路径：1MB 随机数据往返一致", async () => {
    const big = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < big.length; i += 4096) {
      big.fill(i % 251, i, i + 4096);
    }
    const src = writePlain("big.tar.gz", big);
    const dest = filePath("big.tsbak");
    await encryptBackupArchive("big-pass", src, dest);
    const out = filePath("big.dec");
    await decryptBackupArchive("big-pass", dest, out);
    expect(readFileSync(out).equals(big)).toBe(true);
  });
});

/**
 * 备份档口令加密（安全审查 2026-11-02 剩余待办 1，纯 node:crypto）：
 * scrypt 口令派生 + AES-256-GCM 档级流式加密，供桌面端本地备份导出/
 * 恢复链消费（远端上传链不加密——服务端档由部署面 TLS/落盘策略覆盖）。
 *
 * 文件格式（自描述头，旧明文 tar.gz 零迁移兼容）：
 *   `tsbak:v1:` + JSON 头行 + `\n` + GCM 密文 + 16B auth tag
 * - JSON 头行含 scrypt 参数与 salt/nonce——读取侧按档头参数派生，
 *   未来调参旧档仍可解
 * - AAD 绑定整个头行：头被篡改（如降 N 弱化参数）认证必败
 * - 流式实现：内存占用恒定，GB 级档案不整读；解密产物先落同目录
 *   临时文件、认证通过后 rename——认证失败不残留半解密档
 * - 错误二分：格式无效（非密文档/头损坏/参数离谱）vs 口令错误
 *   （GCM 认证失败——口令错与密文篡改在 AEAD 下不可区分，文案合并）
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  type ScryptOptions,
} from "node:crypto";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/** 异步 scrypt（promisify 对回调重载推断不出 options 形态，手包） */
function scryptAsync(
  passphrase: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(passphrase, salt, keylen, options, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export const BACKUP_ARCHIVE_MAGIC = "tsbak:v1:";

/** scrypt 参数：备份档面临离线暴力破解（档外流后攻击者可无限试口令），
 * N=2^16（64MB 内存代价）显著高于登录口令哈希（password.ts 2^14）；
 * 参数随档头自描述，此处只是写入侧当前值 */
const KDF_N = 65536;
const KDF_R = 8;
const KDF_P = 1;
const KEY_LEN = 32;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** 头行长度上限（魔数 + JSON + 换行）——超出按格式无效拒 */
const MAX_HEADER_BYTES = 4096;
/** 档头参数合法域（防恶意档头塞天文参数触发 OOM 型派生） */
const KDF_LIMITS = { n: [16384, 1 << 22], r: [1, 64], p: [1, 16] } as const;

/** 密文档格式无效（非加密备份档 / 头损坏 / 参数离谱） */
export class BackupArchiveFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupArchiveFormatError";
  }
}

/** 口令错误（或密文被篡改——AEAD 下不可区分） */
export class BackupWrongPassphraseError extends Error {
  constructor() {
    super("备份档口令错误或档案已损坏");
    this.name = "BackupWrongPassphraseError";
  }
}

interface ArchiveHeader {
  v: 1;
  kdf: { n: number; r: number; p: number };
  salt: string;
  nonce: string;
}

/** 嗅探：文件头是否 `tsbak:v1:`（读失败/短文件按非密文，调用方分流） */
export function isEncryptedBackupArchive(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const head = Buffer.alloc(BACKUP_ARCHIVE_MAGIC.length);
    const read = readSync(fd, head, 0, head.length, 0);
    return (
      read === head.length && head.toString("utf8") === BACKUP_ARCHIVE_MAGIC
    );
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** 派生密钥（按给定参数；maxmem 显式抬高——node 默认 32MB 会拒 64MB 档） */
async function deriveKey(
  passphrase: string,
  salt: Buffer,
  kdf: { n: number; r: number; p: number },
): Promise<Buffer> {
  const maxmem = 128 * kdf.n * kdf.r + 64 * 1024 * 1024;
  return scryptAsync(passphrase, salt, KEY_LEN, { ...kdf, maxmem });
}

function isValidKdf(kdf: { n: number; r: number; p: number }): boolean {
  return (
    Number.isInteger(kdf.n) &&
    Number.isInteger(kdf.r) &&
    Number.isInteger(kdf.p) &&
    kdf.n >= KDF_LIMITS.n[0] &&
    kdf.n <= KDF_LIMITS.n[1] &&
    kdf.r >= KDF_LIMITS.r[0] &&
    kdf.r <= KDF_LIMITS.r[1] &&
    kdf.p >= KDF_LIMITS.p[0] &&
    kdf.p <= KDF_LIMITS.p[1] &&
    128 * kdf.n * kdf.r <= 1 << 30
  );
}

/** 读档头：魔数 + JSON 行；格式无效抛 BackupArchiveFormatError。
 * 返回头行原始字节（AAD 用）与解析结果 */
function readHeader(file: string): { headerLine: Buffer; header: ArchiveHeader; fileLength: number } {
  const size = statSync(file).size;
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    throw new BackupArchiveFormatError("备份档无法读取");
  }
  try {
    const probe = Buffer.alloc(Math.min(size, MAX_HEADER_BYTES));
    const read = readSync(fd, probe, 0, probe.length, 0);
    const newline = probe.subarray(0, read).indexOf(0x0a);
    if (
      read <= BACKUP_ARCHIVE_MAGIC.length ||
      newline === -1 ||
      probe.subarray(0, BACKUP_ARCHIVE_MAGIC.length).toString("utf8") !==
        BACKUP_ARCHIVE_MAGIC
    ) {
      throw new BackupArchiveFormatError("备份档格式无效（非加密备份档或已损坏）");
    }
    let header: ArchiveHeader;
    try {
      header = JSON.parse(probe.subarray(BACKUP_ARCHIVE_MAGIC.length, newline).toString("utf8"));
    } catch {
      throw new BackupArchiveFormatError("备份档头损坏（无法解析）");
    }
    if (header?.v !== 1 || !isValidKdf(header.kdf) || !header.salt || !header.nonce) {
      throw new BackupArchiveFormatError("备份档头参数无效");
    }
    if (size <= newline + 1 + TAG_BYTES) {
      throw new BackupArchiveFormatError("备份档密文缺失（文件过短）");
    }
    return { headerLine: probe.subarray(0, newline + 1), header, fileLength: size };
  } finally {
    closeSync(fd);
  }
}

/** 同目录临时文件名（rename 原子性要求同卷） */
function tempPathFor(destPath: string): string {
  return join(
    dirname(destPath),
    `.${basename(destPath)}.${randomBytes(6).toString("hex")}.tmp`,
  );
}

/**
 * 加密备份档：srcPath（明文 tar.gz）→ destPath（tsbak:v1 密文档）。
 * 返回最终密文档自身 sha256（调用方落盘对拍口径）。失败不留半成品。
 */
export async function encryptBackupArchive(
  passphrase: string,
  srcPath: string,
  destPath: string,
): Promise<{ sha256: string }> {
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const key = await deriveKey(passphrase, salt, { n: KDF_N, r: KDF_R, p: KDF_P });
  const header: ArchiveHeader = {
    v: 1,
    kdf: { n: KDF_N, r: KDF_R, p: KDF_P },
    salt: salt.toString("base64"),
    nonce: nonce.toString("base64"),
  };
  const headerLine = Buffer.from(
    BACKUP_ARCHIVE_MAGIC + JSON.stringify(header) + "\n",
    "utf8",
  );
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(headerLine);
  // 密文末尾追加 auth tag（flush 时机 tag 已可用）
  const appendTag = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      cb(null, chunk);
    },
    flush(cb) {
      cb(null, cipher.getAuthTag());
    },
  });
  const hash = createHash("sha256");
  const hashAll = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  const tmp = tempPathFor(destPath);
  try {
    const out = createWriteStream(tmp);
    // 头行不经 cipher（明文自描述），先入流与哈希；小包不触发背压边界
    hash.update(headerLine);
    if (!out.write(headerLine)) {
      await new Promise<void>((resolve) => out.once("drain", () => resolve()));
    }
    await pipeline(createReadStream(srcPath), cipher, appendTag, hashAll, out);
    renameSync(tmp, destPath);
    return { sha256: hash.digest("hex") };
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // 临时文件已不存在/清理失败不掩盖原始错误
    }
    throw err;
  }
}

/**
 * 解密备份档：srcPath（tsbak:v1 密文档）→ destPath（明文 tar.gz）。
 * 口令错误/密文被篡改抛 BackupWrongPassphraseError；格式问题抛
 * BackupArchiveFormatError。认证通过才 rename——不残留半解密档。
 */
export async function decryptBackupArchive(
  passphrase: string,
  srcPath: string,
  destPath: string,
): Promise<void> {
  const { headerLine, header, fileLength } = readHeader(srcPath);
  const key = await deriveKey(passphrase, Buffer.from(header.salt, "base64"), header.kdf);
  const nonce = Buffer.from(header.nonce, "base64");
  const tag = Buffer.alloc(TAG_BYTES);
  let fd: number;
  try {
    fd = openSync(srcPath, "r");
  } catch {
    throw new BackupArchiveFormatError("备份档无法读取");
  }
  try {
    readSync(fd, tag, 0, TAG_BYTES, fileLength - TAG_BYTES);
  } finally {
    closeSync(fd);
  }
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(headerLine);
  decipher.setAuthTag(tag);
  const tmp = tempPathFor(destPath);
  try {
    await pipeline(
      createReadStream(srcPath, {
        start: headerLine.length,
        end: fileLength - TAG_BYTES - 1,
      }),
      decipher,
      createWriteStream(tmp),
    );
    renameSync(tmp, destPath);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // 同上：清理失败不掩盖原始错误
    }
    // 流式 GCM 认证失败以 stream error 冒出（"unable to authenticate
    // data"）——口令错与篡改不可区分，统一口径
    throw new BackupWrongPassphraseError();
  }
}

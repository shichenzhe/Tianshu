/**
 * ustar tar.gz 手写打包/解包器（spec 2026-10-27 §1）：零新依赖（node 内置，
 * 依赖白名单互锁不动），标准 ustar 格式（GNU/bsdtar 可互验互解）。
 * 核心不变量：每条目 = 512 字节 header + size 字节内容 + pad 至 512 倍数；
 * 档尾双零块。约束：relPath（prefix+name）超 255 抛错中止——备份不静默
 * 丢数据；解包 entry 路径越出 destDir 抛错（防路径穿越）；GNU tar 相对
 * 路径打包（cd src && tar -czf out .）产生的 "./" 前缀先剥再校验，
 * 纯 "./" 条目（档根）跳过；mtime 取源文件 stat 保真（非打包时刻）。
 * 解包容忍真实世界 tar 的元数据条目：pax 扩展头（typeflag "x"，macOS
 * bsdtar 相对路径打包必带）取 path= 覆盖下一条目名、GNU 长名（"L"）同
 * 理生效，全局头 "g"/长链接名 "K" 跳过；其余 typeflag（符号链接等）
 * 显式抛错不静默。
 */
import { once } from "node:events";
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  statSync,
  utimesSync,
  type WriteStream,
} from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip, type Gzip } from "node:zlib";

export interface TarEntry {
  relPath: string;
  absPath: string;
  size: number;
}

const BLOCK = 512;
const NAME_MAX = 100;
const PREFIX_MAX = 155;

/** entry 路径防御（绝对路径 / .. / 反斜杠 / 空段 / NUL 字节一律拒绝） */
export function assertSafeEntry(relPath: string): void {
  if (
    !relPath ||
    relPath.includes("\0") ||
    relPath.includes("\\") ||
    relPath.startsWith("/") ||
    relPath.split("/").some((seg) => seg === "" || seg === "." || seg === "..")
  ) {
    throw new Error(`unsafe tar entry: ${relPath}`);
  }
}

/** 八进制字段（len-1 位数字 + NUL 填充） */
function octal(value: number, len: number): Buffer {
  const s = value.toString(8).padStart(len - 1, "0");
  if (s.length > len - 1) throw new Error(`tar octal field overflow: ${value}`);
  const buf = Buffer.alloc(len);
  buf.write(s + "\0", 0, "ascii");
  return buf;
}

/** 长路径切 ustar prefix（≤155）+ name（≤100）；无法表达即抛错不静默 */
function splitPath(relPath: string): { name: string; prefix: string } {
  if (Buffer.byteLength(relPath) <= NAME_MAX)
    return { name: relPath, prefix: "" };
  const seps: number[] = [];
  for (let i = relPath.indexOf("/"); i >= 0; i = relPath.indexOf("/", i + 1))
    seps.push(i);
  for (let i = seps.length - 1; i >= 0; i--) {
    if (seps[i] === 0) break;
    const prefix = relPath.slice(0, seps[i]);
    const name = relPath.slice(seps[i] + 1);
    if (
      Buffer.byteLength(prefix) <= PREFIX_MAX &&
      Buffer.byteLength(name) <= NAME_MAX
    ) {
      return { name, prefix };
    }
  }
  throw new Error(`tar path >255 unsupported: ${relPath}`);
}

function padSize(size: number): number {
  return (BLOCK - (size % BLOCK)) % BLOCK;
}

function byteSum(buf: Buffer): number {
  let sum = 0;
  for (const b of buf) sum += b;
  return sum;
}

/** 512 字节 ustar header（目录条目名带尾 "/"——GNU tar 惯例，-t 列表一致） */
function buildHeader(
  entry: TarEntry,
  mtimeSec: number,
  isDir: boolean,
): Buffer {
  assertSafeEntry(entry.relPath);
  const split = splitPath(entry.relPath);
  const name = isDir ? `${split.name}/` : split.name;
  if (Buffer.byteLength(name) > NAME_MAX) {
    throw new Error(`tar path >255 unsupported: ${entry.relPath}`);
  }
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, NAME_MAX, "utf8");
  h.write(split.prefix, 345, PREFIX_MAX, "utf8");
  octal(isDir ? 0o755 : 0o644, 8).copy(h, 100);
  octal(0, 8).copy(h, 108);
  octal(0, 8).copy(h, 116);
  octal(isDir ? 0 : entry.size, 12).copy(h, 124);
  octal(mtimeSec, 12).copy(h, 136);
  h.fill(" ", 148, 156);
  h.write(isDir ? "5" : "0", 156, "ascii");
  h.write("ustar\0", 257, "ascii");
  h.write("00", 263, "ascii");
  h.write(byteSum(h).toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return h;
}

/**
 * 流错误哨兵：race 进 drain/end 等待点，任一流出错即整体拒绝
 * （catch 挂空防未处理 rejection 告警）
 */
function onStreamError(
  ...streams: Array<{
    once(event: "error", listener: (err: Error) => void): unknown;
  }>
): Promise<never> {
  const failure = new Promise<never>((_, reject) => {
    for (const s of streams) s.once("error", reject);
  });
  failure.catch(() => undefined);
  return failure;
}

async function writeChunk(
  gz: Gzip,
  chunk: Buffer,
  failure: Promise<never>,
): Promise<void> {
  if (!gz.write(chunk)) await Promise.race([once(gz, "drain"), failure]);
}

/** 文件内容流式写入 gz（手动背压；实写字节数与 entry.size 不符即中止） */
async function copyFileContent(
  gz: Gzip,
  entry: TarEntry,
  failure: Promise<never>,
): Promise<void> {
  const rs = createReadStream(entry.absPath);
  let written = 0;
  try {
    for await (const chunk of rs) {
      written += (chunk as Buffer).length;
      await writeChunk(gz, chunk as Buffer, failure);
    }
    if (written !== entry.size) {
      throw new Error(
        `tar entry size mismatch: ${entry.relPath} 期望 ${entry.size} 实写 ${written}`,
      );
    }
  } finally {
    rs.destroy();
  }
}

export async function packTarGz(
  entries: TarEntry[],
  outFile: string,
): Promise<void> {
  const out = createWriteStream(outFile);
  const gz = createGzip();
  gz.pipe(out);
  const failure = onStreamError(gz, out);
  try {
    for (const entry of entries) {
      const stat = statSync(entry.absPath);
      const isDir = stat.isDirectory();
      await writeChunk(
        gz,
        buildHeader(entry, Math.floor(stat.mtimeMs / 1000), isDir),
        failure,
      );
      if (!isDir) await copyFileContent(gz, entry, failure);
      const pad = padSize(entry.size);
      if (pad > 0) await writeChunk(gz, Buffer.alloc(pad), failure);
    }
    await writeChunk(gz, Buffer.alloc(BLOCK * 2), failure);
    gz.end();
    await Promise.race([once(gz, "finish"), failure]);
    await Promise.race([once(out, "close"), failure]);
  } catch (err) {
    gz.destroy();
    out.destroy();
    throw err;
  }
}

interface ParsedHeader {
  name: string;
  size: number;
  mtime: number;
  typeflag: string;
}

/** NUL 结尾字符串字段（无 NUL 则取满整段） */
function parseStringField(block: Buffer, off: number, len: number): string {
  const end = off + len;
  const nul = block.indexOf(0, off);
  return block.toString("utf8", off, nul === -1 || nul >= end ? end : nul);
}

/** 八进制字段解析（容 NUL/空格首尾填充；base-256 二进制编码不支持） */
function parseOctal(block: Buffer, off: number, len: number): number {
  if ((block[off] & 0x80) !== 0)
    throw new Error("tar base-256 field unsupported");
  const end = off + len;
  let start = off;
  let stop = end;
  while (start < end && (block[start] === 0 || block[start] === 0x20)) start++;
  while (stop > start && (block[stop - 1] === 0 || block[stop - 1] === 0x20))
    stop--;
  if (start === stop) return 0;
  const s = block.toString("ascii", start, stop);
  if (!/^[0-7]+$/.test(s)) throw new Error(`invalid tar octal field: ${s}`);
  return parseInt(s, 8);
}

/** header 校验和：chksum 段置空格求全 512 字节和，与记录值比对 */
function verifyChecksum(block: Buffer): void {
  const probe = Buffer.from(block);
  probe.fill(" ", 148, 156);
  const actual = byteSum(probe);
  const recorded = parseOctal(block, 148, 8);
  if (actual !== recorded)
    throw new Error(`tar header checksum mismatch: ${recorded} != ${actual}`);
}

function parseHeader(block: Buffer): ParsedHeader {
  const magic = block.toString("binary", 257, 263);
  if (magic !== "ustar\0" && magic !== "ustar ")
    throw new Error("invalid tar: not ustar format");
  verifyChecksum(block);
  const prefix = parseStringField(block, 345, PREFIX_MAX);
  const name = parseStringField(block, 0, NAME_MAX);
  return {
    name: prefix ? `${prefix}/${name}` : name,
    size: parseOctal(block, 124, 12),
    mtime: parseOctal(block, 136, 12),
    typeflag: String.fromCharCode(block[156]),
  };
}

/**
 * 解包侧条目名归一：GNU tar 相对路径打包带 "./" 前缀、目录条目带尾 "/"，
 * 先剥再校验；剥完为空（纯 "./" 档根条目）返回 null 跳过
 */
function normalizeEntryName(raw: string): string | null {
  let name = raw;
  while (name.startsWith("./")) name = name.slice(2);
  while (name.endsWith("/")) name = name.slice(0, -1);
  if (!name || name === ".") return null;
  return name;
}

/** 双重防线：join 后再验相对路径未越出 destDir（防穿越兜底） */
function assertWithinDest(destDir: string, target: string): void {
  const rel = path.relative(destDir, target);
  if (!rel || path.isAbsolute(rel) || rel.split(path.sep).includes("..")) {
    throw new Error(`tar entry escapes destDir: ${target}`);
  }
}

class TarExtractor {
  private buf: Buffer = Buffer.alloc(0);
  private phase: "header" | "data" | "meta" | "skip" = "header";
  private header: ParsedHeader | null = null;
  private remaining = 0;
  private metaParts: Buffer[] = [];
  private metaKind: "x" | "L" = "x";
  private pendingPath: string | null = null;
  private file: WriteStream | null = null;
  private fileFailure = new Promise<never>(() => undefined);
  private target = "";
  private done = false;

  constructor(private readonly destDir: string) {}

  async consume(tar: Readable): Promise<void> {
    mkdirSync(this.destDir, { recursive: true });
    for await (const chunk of tar) {
      this.buf =
        this.buf.length === 0
          ? (chunk as Buffer)
          : Buffer.concat([this.buf, chunk as Buffer]);
      await this.pump();
      if (this.done) break;
    }
    if (!this.done) throw new Error("tar 档截断：未见结尾零块");
  }

  private async pump(): Promise<void> {
    while (!this.done) {
      if (this.phase === "header") {
        if (!(await this.stepHeader())) break;
      } else if (this.phase === "data") {
        if (!(await this.stepData())) break;
      } else if (this.phase === "meta") {
        if (!this.stepMeta()) break;
      } else if (!this.stepSkip()) break;
    }
  }

  private async stepHeader(): Promise<boolean> {
    if (this.buf.length < BLOCK) return false;
    const block = this.buf.subarray(0, BLOCK);
    this.buf = this.buf.subarray(BLOCK);
    if (block.every((b) => b === 0)) {
      this.done = true;
      return false;
    }
    const header = parseHeader(block);
    this.header = header;
    if (header.typeflag === "x" || header.typeflag === "L") {
      this.beginMeta(header.typeflag);
    } else if (header.typeflag === "g" || header.typeflag === "K") {
      this.skipEntry(header);
    } else {
      await this.extractEntry(header);
    }
    return true;
  }

  private beginMeta(kind: "x" | "L"): void {
    this.metaKind = kind;
    this.metaParts = [];
    this.remaining = this.header!.size;
    this.phase = "meta";
  }

  /** 元数据条目收尾：pax 取 path= 记录，GNU 长名整体即路径 */
  private finishMeta(): void {
    const data = Buffer.concat(this.metaParts);
    this.metaParts = [];
    if (this.metaKind === "L") {
      this.pendingPath = data.toString("utf8").replace(/\0+$/, "");
    } else {
      this.pendingPath = parsePaxRecords(data).path ?? null;
    }
    this.phase = "skip";
    this.remaining = padSize(this.header!.size);
  }

  private skipEntry(header: ParsedHeader): void {
    this.pendingPath = null;
    this.phase = "skip";
    this.remaining = header.size + padSize(header.size);
  }

  private async extractEntry(header: ParsedHeader): Promise<void> {
    const name = normalizeEntryName(this.pendingPath ?? header.name);
    this.pendingPath = null;
    if (name === null) {
      this.skipEntry(header);
    } else if (header.typeflag === "5") {
      this.extractDir(name);
    } else if (header.typeflag === "0" || header.typeflag === "\0") {
      await this.openFile(name);
    } else {
      throw new Error(
        `tar typeflag unsupported: ${header.typeflag} (${header.name})`,
      );
    }
  }

  private extractDir(name: string): void {
    assertSafeEntry(name);
    const dest = path.join(this.destDir, name);
    assertWithinDest(this.destDir, dest);
    mkdirSync(dest, { recursive: true });
    this.phase = "skip";
    this.remaining = this.header!.size + padSize(this.header!.size);
  }

  private async openFile(name: string): Promise<void> {
    assertSafeEntry(name);
    const dest = path.join(this.destDir, name);
    assertWithinDest(this.destDir, dest);
    mkdirSync(path.dirname(dest), { recursive: true });
    this.target = dest;
    this.file = createWriteStream(dest);
    this.fileFailure = onStreamError(this.file);
    this.remaining = this.header!.size;
    this.phase = "data";
  }

  private async stepData(): Promise<boolean> {
    if (this.remaining === 0) {
      await this.closeFile();
      return true;
    }
    if (this.buf.length === 0) return false;
    const take = Math.min(this.buf.length, this.remaining);
    const data = this.buf.subarray(0, take);
    this.buf = this.buf.subarray(take);
    this.remaining -= take;
    const file = this.file!;
    if (!file.write(data))
      await Promise.race([once(file, "drain"), this.fileFailure]);
    if (this.remaining === 0) await this.closeFile();
    return true;
  }

  private async closeFile(): Promise<void> {
    const file = this.file;
    this.file = null;
    file!.end();
    await Promise.race([once(file!, "finish"), this.fileFailure]);
    const mtime = this.header?.mtime ?? 0;
    if (mtime > 0) utimesSync(this.target, mtime, mtime);
    this.phase = "skip";
    this.remaining = padSize(this.header!.size);
  }

  /** 元数据条目（pax/GNU 长名）数据段：攒够 size 字节后解析 */
  private stepMeta(): boolean {
    if (this.remaining === 0) {
      this.finishMeta();
      return true;
    }
    if (this.buf.length === 0) return false;
    const take = Math.min(this.buf.length, this.remaining);
    this.metaParts.push(Buffer.from(this.buf.subarray(0, take)));
    this.buf = this.buf.subarray(take);
    this.remaining -= take;
    if (this.remaining === 0) this.finishMeta();
    return true;
  }

  private stepSkip(): boolean {
    if (this.remaining === 0) {
      this.phase = "header";
      this.header = null;
      return true;
    }
    if (this.buf.length === 0) return false;
    const take = Math.min(this.buf.length, this.remaining);
    this.buf = this.buf.subarray(take);
    this.remaining -= take;
    if (this.remaining === 0) {
      this.phase = "header";
      this.header = null;
    }
    return true;
  }
}

/**
 * pax 扩展记录解析（"<len> key=value\\n" 长度前缀自描述格式）；
 * 本解包器只消费 path= 覆盖，其余键（mtime 精度/权限等）忽略
 */
function parsePaxRecords(data: Buffer): Record<string, string> {
  const records: Record<string, string> = {};
  const text = data.toString("utf8");
  let pos = 0;
  while (pos < text.length) {
    const sp = text.indexOf(" ", pos);
    const len = sp < 0 ? NaN : parseInt(text.slice(pos, sp), 10);
    if (!Number.isInteger(len) || len <= 0 || pos + len > text.length) {
      throw new Error("invalid pax record");
    }
    const record = text.slice(sp + 1, pos + len - 1);
    const eq = record.indexOf("=");
    if (eq > 0) records[record.slice(0, eq)] = record.slice(eq + 1);
    pos += len;
  }
  return records;
}

export async function unpackTarGz(
  archiveFile: string,
  destDir: string,
): Promise<void> {
  const src = createReadStream(archiveFile);
  const gun = createGunzip();
  src.pipe(gun);
  const failure = onStreamError(src, gun);
  try {
    await Promise.race([new TarExtractor(destDir).consume(gun), failure]);
  } finally {
    // 早停（零块后尚余填充块）时显式关流，防 src fd 悬挂
    src.destroy();
    gun.destroy();
  }
}

/** 首 header 魔数末端偏移（parseHeader 同口径：257..263） */
const USTAR_MAGIC_END = 263;

/**
 * 本地档案预检（本地恢复链无远端 meta 可 sha256 对拍的替代闸门）：
 * 流式 gunzip 全量过一遍——gzip 截断/CRC 损坏在 zlib 收尾抛错，首
 * header ustar 魔数嗅探（与 parseHeader 同接受面）拦非本格式档案。
 * 全程零落盘；放在断库/保护副本之前，坏档不付 GB 级快照成本。
 */
export async function verifyTarGzIntegrity(
  archivePath: string,
): Promise<void> {
  // 首 header 经对象属性承载（TS 对闭包捕获 let 的外层收窄会误判 never，
  // 属性访问不收窄——行为无差）
  const state: { head: Buffer | null } = { head: null };
  try {
    await pipeline(
      createReadStream(archivePath),
      createGunzip(),
      async (source: Readable) => {
        for await (const chunk of source) {
          const head = state.head;
          // 魔数已验过即排干余量（读到底才触发 gzip CRC 收尾校验）
          if (head !== null && head.length >= USTAR_MAGIC_END) continue;
          const buffered = head
            ? Buffer.concat([head, chunk])
            : Buffer.from(chunk);
          state.head = buffered;
          if (buffered.length >= USTAR_MAGIC_END) {
            const magic = buffered.toString("binary", 257, USTAR_MAGIC_END);
            if (magic !== "ustar\0" && magic !== "ustar ") {
              throw new Error("非 ustar tar.gz 档案（魔数不符）");
            }
          }
        }
      },
    );
  } catch (err) {
    throw new Error(
      `备份档案校验失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // 解压总量不足一个 header（空档/碎档）——按魔数缺失报错
  if (state.head === null || state.head.length < USTAR_MAGIC_END) {
    throw new Error("备份档案校验失败：非 ustar tar.gz 档案（内容不足）");
  }
}

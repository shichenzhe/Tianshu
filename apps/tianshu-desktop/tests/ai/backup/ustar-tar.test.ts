// ustar 手写打包/解包器单测：GNU/bsdtar 互验（标准格式权威对拍）+ 边界。
// import 相对路径形态照 tests/ai/ 嵌套子目录既有用例（如 tests/ai/server/*）
// ——子目录再深一层，须 ../../../electron。
// 注：brief 用例 2 原值（120+120 分段）在 ustar 下不可表达（name 段 126>100），
// 调整为 100+50 分段——仍 >100 需 prefix、prefix 151 逼近 155 上限，意图不变。
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  assertSafeEntry,
  packTarGz,
  unpackTarGz,
} from "../../../electron/domains/backup/ustar-tar";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "ustar-"));
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** 手工 ustar header（绕开打包器校验，喂解包器做负样） */
function craftHeader(name: string): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write("0000644\0", 100, "ascii");
  h.write("0000000\0", 108, "ascii");
  h.write("0000000\0", 116, "ascii");
  h.write("00000000001\0", 124, "ascii");
  h.write("00000000000\0", 136, "ascii");
  h.fill(" ", 148, 156);
  h.write("0", 156, "ascii");
  h.write("ustar\0", 257, "ascii");
  h.write("00", 263, "ascii");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return h;
}

/** 单条目（1 字节内容）tar.gz，entry 名可控 */
const craftSingleEntryTarGz = (name: string): Buffer =>
  gzipSync(
    Buffer.concat([
      craftHeader(name),
      Buffer.from("x"),
      Buffer.alloc(511),
      Buffer.alloc(1024),
    ]),
  );

describe("ustar-tar", () => {
  it("基本往返：文件+目录树 → 解包内容一致（含 mtime 保真）", async () => {
    const src = tmp();
    mkdirSync(path.join(src, "database"), { recursive: true });
    writeFileSync(
      path.join(src, "database", "local.db"),
      Buffer.alloc(1024, 3),
    );
    writeFileSync(path.join(src, ".jwt-secret"), "secret");
    const out = path.join(tmp(), "a.tar.gz");
    await packTarGz(
      [
        { relPath: "database", absPath: path.join(src, "database"), size: 0 },
        {
          relPath: "database/local.db",
          absPath: path.join(src, "database", "local.db"),
          size: 1024,
        },
        {
          relPath: ".jwt-secret",
          absPath: path.join(src, ".jwt-secret"),
          size: 6,
        },
      ],
      out,
    );
    // GNU tar 互验：标准工具可列出（格式权威对拍）
    const listing = execSync(`tar -tzf ${out}`)
      .toString()
      .trim()
      .split("\n")
      .sort();
    expect(listing).toEqual([".jwt-secret", "database/", "database/local.db"]);
    const dest = tmp();
    await unpackTarGz(out, dest);
    expect(sha(readFileSync(path.join(dest, "database", "local.db")))).toBe(
      sha(readFileSync(path.join(src, "database", "local.db"))),
    );
    expect(readFileSync(path.join(dest, ".jwt-secret"), "utf8")).toBe("secret");
    // mtime 用源文件 stat 保真（取整秒），恢复后偏差 <1s
    const mtimeDiff = Math.abs(
      statSync(path.join(src, "database", "local.db")).mtimeMs -
        statSync(path.join(dest, "database", "local.db")).mtimeMs,
    );
    expect(mtimeDiff).toBeLessThanOrEqual(1000);
  });

  it("长路径（100~255）：prefix 字段生效，GNU tar 互验可解", async () => {
    const src = tmp();
    const deep = path.join(src, "a".repeat(100), "b".repeat(50), "c.txt");
    mkdirSync(path.dirname(deep), { recursive: true });
    writeFileSync(deep, "deep");
    const relPath = `${"a".repeat(100)}/${"b".repeat(50)}/c.txt`;
    const out = path.join(tmp(), "b.tar.gz");
    await packTarGz([{ relPath, absPath: deep, size: 4 }], out);
    // 系统工具互验：能列出且能解开（prefix 拼回全路径）
    expect(execSync(`tar -tzf ${out}`).toString().trim()).toBe(relPath);
    const sysDest = tmp();
    execSync(`tar -xzf ${out} -C ${sysDest}`);
    expect(
      readFileSync(path.join(sysDest, ...relPath.split("/")), "utf8"),
    ).toBe("deep");
    const dest = tmp();
    await unpackTarGz(out, dest);
    expect(readFileSync(path.join(dest, ...relPath.split("/")), "utf8")).toBe(
      "deep",
    );
  });

  it("超 255 路径：报错中止（备份不静默丢数据）", async () => {
    const src = tmp();
    const p = path.join(src, "f");
    writeFileSync(p, "x");
    await expect(
      packTarGz(
        [
          {
            relPath: `${"x".repeat(200)}/y${"z".repeat(100)}`,
            absPath: p,
            size: 1,
          },
        ],
        path.join(tmp(), "c.tar.gz"),
      ),
    ).rejects.toThrow(/255/);
  });

  it("空文件与多文件混合", async () => {
    const src = tmp();
    writeFileSync(path.join(src, "empty"), "");
    writeFileSync(path.join(src, "two"), "22");
    const out = path.join(tmp(), "d.tar.gz");
    await packTarGz(
      [
        { relPath: "empty", absPath: path.join(src, "empty"), size: 0 },
        { relPath: "two", absPath: path.join(src, "two"), size: 2 },
      ],
      out,
    );
    const dest = tmp();
    await unpackTarGz(out, dest);
    expect(statSync(path.join(dest, "empty")).size).toBe(0);
    expect(readFileSync(path.join(dest, "two"), "utf8")).toBe("22");
  });

  it("解包越界路径（../）：拒绝", async () => {
    // 防御函数直测（pack 侧同款校验）
    expect(() => assertSafeEntry("../escape")).toThrow();
    expect(() => assertSafeEntry("a/../../b")).toThrow();
    expect(() => assertSafeEntry("/abs")).toThrow();
    expect(() => assertSafeEntry("a/b/c")).not.toThrow();
    // 手工恶意档端到端：解包器必须拒（不静默跳过、不落盘越界文件）
    const archive = path.join(tmp(), "evil.tar.gz");
    writeFileSync(archive, craftSingleEntryTarGz("../escape"));
    await expect(unpackTarGz(archive, tmp())).rejects.toThrow(
      /unsafe|escapes/i,
    );
  });

  it("GNU tar 相对路径打包（./ 前缀）：剥前缀且跳过纯 ./ 条目", async () => {
    const src = tmp();
    mkdirSync(path.join(src, "nested"));
    writeFileSync(path.join(src, "nested", "f.txt"), "rel");
    writeFileSync(path.join(src, "top"), "t");
    const out = path.join(tmp(), "rel.tar.gz");
    // bsdtar 相对路径打包产出 "./"、"./nested/"、"./nested/f.txt"、"./top"
    // 及 macOS 的 ._ AppleDouble 与 PaxHeader 元数据条目
    execSync(`tar -czf ${out} .`, { cwd: src });
    const dest = tmp();
    await unpackTarGz(out, dest);
    expect(readFileSync(path.join(dest, "nested", "f.txt"), "utf8")).toBe(
      "rel",
    );
    expect(readFileSync(path.join(dest, "top"), "utf8")).toBe("t");
    // pax 元数据条目不得落盘为真实文件
    expect(existsSync(path.join(dest, "PaxHeader"))).toBe(false);
  });
});

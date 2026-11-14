import { describe, expect, it } from "vitest";
import {
  buildSeatbeltProfile,
  escapeSbplString,
  normalizeMacPrivatePath,
} from "../../electron/domains/security/sandbox/profile";

describe("escapeSbplString（sbpl 字符串字面量转义）", () => {
  it("普通路径原样", () => {
    expect(escapeSbplString("/Users/hjx/work")).toBe("/Users/hjx/work");
  });

  it("反斜杠与双引号转义", () => {
    expect(escapeSbplString('a"b\\c')).toBe('a\\"b\\\\c');
  });
});

describe("normalizeMacPrivatePath（/private 符号链接归一）", () => {
  it("/var/folders 前缀归一到 /private/var/folders", () => {
    expect(normalizeMacPrivatePath("/var/folders/ab/123/T")).toBe(
      "/private/var/folders/ab/123/T",
    );
  });

  it("/tmp 与 /etc 同归一", () => {
    expect(normalizeMacPrivatePath("/tmp/ws")).toBe("/private/tmp/ws");
    expect(normalizeMacPrivatePath("/etc/hosts")).toBe("/private/etc/hosts");
  });

  it("已是 /private 前缀与用户路径不动", () => {
    expect(normalizeMacPrivatePath("/private/var/folders/x")).toBe(
      "/private/var/folders/x",
    );
    expect(normalizeMacPrivatePath("/Users/hjx/ws")).toBe("/Users/hjx/ws");
  });
});

describe("buildSeatbeltProfile（workspace-write profile 生成）", () => {
  it("普通 workspace：写白名单 = workspace + TMPDIR + 设备节点", () => {
    const profile = buildSeatbeltProfile("/Users/hjx/ws", "/private/var/folders/ab/T");
    expect(profile).toContain("(version 1)");
    expect(profile).toContain("(allow default)");
    expect(profile).toContain("(deny file-write*)");
    expect(profile).toContain('(subpath "/Users/hjx/ws")');
    expect(profile).toContain('(subpath "/private/var/folders/ab/T")');
    expect(profile).toContain('(literal "/dev/null") (literal "/dev/tty")');
  });

  it("workspace 含空格/中文/引号全部转义", () => {
    const profile = buildSeatbeltProfile(
      '/Users/hjx/我的 空间"quote',
      "/private/var/folders/ab/T",
    );
    expect(profile).toContain(
      '(subpath "/Users/hjx/我的 空间\\"quote")',
    );
  });

  it("TMPDIR 传 /var 形态时归一为 /private/var", () => {
    const profile = buildSeatbeltProfile("/Users/hjx/ws", "/var/folders/ab/T");
    expect(profile).toContain('(subpath "/private/var/folders/ab/T")');
    expect(profile).not.toContain('(subpath "/var/folders');
  });

  it("网络与读零约束：profile 不含 network/read 拒绝行", () => {
    const profile = buildSeatbeltProfile("/Users/hjx/ws", "/private/var/folders/ab/T");
    expect(profile).not.toMatch(/network/);
    expect(profile).not.toMatch(/file-read/);
  });
});

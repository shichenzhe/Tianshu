import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  decideFileAccess,
  normalizeRulePath,
  pathMatchesRule,
  type FileAccessRules,
} from "../../electron/domains/security/file-policy";

const WS = "/tmp/ws";
const HOME = os.homedir();

const rules = (over: Partial<FileAccessRules> = {}): FileAccessRules => ({
  builtinBlocklist: [path.join(HOME, ".ssh")],
  fileBlocklist: ["/secret"],
  fileAllowlist: ["/tmp/ws/build"],
  ...over,
});

describe("normalizeRulePath", () => {
  it("~ 展开 / 绝对原样 / 相对按 workspace resolve / 去尾分隔符与通配符", () => {
    expect(normalizeRulePath("~/.ssh/", WS)).toBe(path.join(HOME, ".ssh"));
    expect(normalizeRulePath("~/.ssh/config*", WS)).toBe(
      path.join(HOME, ".ssh", "config"),
    );
    expect(normalizeRulePath("/abs/dir", WS)).toBe(path.normalize("/abs/dir"));
    expect(normalizeRulePath("rel/dir", WS)).toBe(path.resolve(WS, "rel/dir"));
  });
  it("/dir/* 形态循环剥离至稳定，孤立 * 归空", () => {
    expect(normalizeRulePath("/secret/*", WS)).toBe("/secret");
    expect(normalizeRulePath("*", WS)).toBe("");
  });
});

describe("pathMatchesRule", () => {
  it("精确文件与目录前缀双匹配；同级不同名不误伤", () => {
    expect(pathMatchesRule("/a/b/file", "/a/b")).toBe(true);
    expect(pathMatchesRule("/a/b", "/a/b")).toBe(true);
    expect(pathMatchesRule("/a/b2/file", "/a/b")).toBe(false);
    expect(pathMatchesRule("/x", "")).toBe(false);
  });
  it("不区分大小写文件系统（darwin/win32）上大小写变体命中", () => {
    // darwin APFS / win32 NTFS 不区分大小写：~/.SSH/config 读同一文件须命中
    // （linux 等区分大小写文件系统折叠关闭，恒 false）
    expect(pathMatchesRule("/Users/x/.SSH/config", "/Users/x/.ssh")).toBe(
      process.platform === "darwin" || process.platform === "win32",
    );
  });
});

describe("decideFileAccess 优先级矩阵", () => {
  it("内置最高：不可被用户白名单绕过", () => {
    const r = rules({
      fileAllowlist: [path.join(HOME, ".ssh")],
    });
    expect(decideFileAccess(path.join(HOME, ".ssh", "id_rsa"), WS, r)).toBe(
      "block",
    );
  });
  it("用户白名单优先于用户黑名单", () => {
    const r = rules({
      fileBlocklist: ["/data"],
      fileAllowlist: ["/data/public"],
    });
    expect(decideFileAccess("/data/public/a.txt", WS, r)).toBe("allow");
    expect(decideFileAccess("/data/private/a.txt", WS, r)).toBe("block");
  });
  it("用户黑名单目录前缀命中 → block；未命中 → default", () => {
    expect(decideFileAccess("/secret/key.pem", WS, rules())).toBe("block");
    expect(decideFileAccess("/tmp/ws/src/a.ts", WS, rules())).toBe("default");
  });
  it("相对条目按 workspace 解析", () => {
    const r = rules({ fileBlocklist: ["secrets"] });
    expect(decideFileAccess(path.join(WS, "secrets", "k"), WS, r)).toBe(
      "block",
    );
  });
});

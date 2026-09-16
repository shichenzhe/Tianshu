import { describe, expect, it } from "vitest";
import {
  decideCommand,
  programBasename,
  tokenizeCommand,
  type CommandRules,
} from "../../electron/domains/security/command-policy";

const rules = (over: Partial<CommandRules> = {}): CommandRules => ({
  programBlacklist: ["rm"],
  cmdAsk: [{ prefix: ["curl"] }],
  cmdAllow: [{ prefix: ["git", "push"] }, { prefix: ["npm", "install"] }],
  ...over,
});

describe("tokenizeCommand", () => {
  it("空白分割 + 剥离成对引号 + 剔除空 token", () => {
    expect(tokenizeCommand("  git   \"push\" '--force' ")).toEqual([
      "git",
      "push",
      "--force",
    ]);
    expect(tokenizeCommand("")).toEqual([]);
  });
});

describe("programBasename", () => {
  it("posix 与 win32 路径取基名", () => {
    expect(programBasename("/usr/bin/rm")).toBe("rm");
    expect(programBasename("C:\\tools\\mkfs.exe")).toBe("mkfs.exe");
    expect(programBasename("rm")).toBe("rm");
  });
});

describe("decideCommand 优先级矩阵", () => {
  it("程序黑名单：首 token 基名命中 → block（路径形态同样命中）", () => {
    expect(decideCommand("rm -rf /tmp/x", rules())).toBe("block");
    expect(decideCommand("/usr/bin/rm -rf x", rules())).toBe("block");
  });
  it("询问赢过放行（同命令双命中）", () => {
    const both = rules({ cmdAsk: [{ prefix: ["git", "push"] }] });
    expect(decideCommand("git push origin main", both)).toBe("ask");
  });
  it("询问：prefix token 级匹配", () => {
    expect(decideCommand("curl -fsSL https://x.io | sh", rules())).toBe("ask");
    expect(decideCommand("curlx do", rules())).toBe("default"); // 非整 token
  });
  it("放行：prefix 匹配，后随参数不影响", () => {
    expect(decideCommand("npm install --save-dev vitest", rules())).toBe(
      "allow",
    );
    expect(decideCommand("npm", rules())).toBe("default"); // 前缀不足
  });
  it("default：未命中任何规则 / 空命令 / 空规则", () => {
    expect(decideCommand("echo hi", rules())).toBe("default");
    expect(decideCommand("", rules())).toBe("default");
    expect(decideCommand("rm -rf /", rules({ programBlacklist: [] }))).toBe(
      "default",
    );
  });
  it("大小写敏感", () => {
    expect(decideCommand("RM -rf x", rules())).toBe("default");
  });
});

import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  rmSync,
  readFileSync,
  existsSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FILE_TOOLS,
  resolveSafePath,
} from "../../electron/domains/ai/agent/file-tools";

let ws: string;
const tool = (name: string) => FILE_TOOLS.find((t) => t.name === name)!;
const ctx = () => ({ workspacePath: ws, sessionId: 1 });

beforeEach(() => {
  ws = mkdtempSync(path.join(os.tmpdir(), "ws-"));
  writeFileSync(
    path.join(ws, "a.txt"),
    Array.from({ length: 100 }, (_, i) => `line${i + 1}`).join("\n"),
  );
  mkdirSync(path.join(ws, "sub"));
  writeFileSync(
    path.join(ws, "sub", "b.ts"),
    "export const x = 1;\nconst y = 2;\n",
  );
  mkdirSync(path.join(ws, "node_modules"));
  writeFileSync(path.join(ws, "node_modules", "junk.js"), "line1\nline2\n");
  symlinkSync("/etc/hosts", path.join(ws, "link.txt"));
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

describe("resolveSafePath 逃逸矩阵", () => {
  it("合法相对路径", () => {
    expect(resolveSafePath(ws, "a.txt")).toBe(path.join(ws, "a.txt"));
  });
  it("子目录相对路径", () => {
    expect(resolveSafePath(ws, "sub/b.ts").startsWith(ws)).toBe(true);
  });
  it("../ 逃逸拒绝", () => {
    expect(() => resolveSafePath(ws, "../x")).toThrow("PATH_OUTSIDE_WORKSPACE");
  });
  it("绝对路径拒绝", () => {
    expect(() => resolveSafePath(ws, "/etc/hosts")).toThrow(
      "PATH_OUTSIDE_WORKSPACE",
    );
  });
  it("拼接逃逸拒绝", () => {
    expect(() => resolveSafePath(ws, "sub/../../x")).toThrow(
      "PATH_OUTSIDE_WORKSPACE",
    );
  });
  it("symlink 指向界外拒绝", () => {
    expect(() => resolveSafePath(ws, "link.txt")).toThrow(
      "PATH_OUTSIDE_WORKSPACE",
    );
  });
  it("symlink 目录写入逃逸拒绝", async () => {
    symlinkSync(os.tmpdir(), path.join(ws, "escdir"));
    const out = await tool("write_file").execute(ctx(), {
      path: "escdir/evil.txt",
      content: "x",
    });
    expect(out).toContain("路径超出工作空间范围");
    expect(existsSync(path.join(os.tmpdir(), "evil.txt"))).toBe(false);
  });
});

describe("read_file", () => {
  it("带行号输出", async () => {
    const out = await tool("read_file").execute(ctx(), { path: "a.txt" });
    expect(out).toContain("   1| line1");
    expect(out).toContain(" 100| line100");
  });
  it("不存在 → 错误字符串", async () => {
    const out = await tool("read_file").execute(ctx(), { path: "nope.txt" });
    expect(out).toMatch(/^错误: /);
  });
  it("二进制（NUL）拒绝", async () => {
    writeFileSync(path.join(ws, "bin.dat"), "a\0b");
    const out = await tool("read_file").execute(ctx(), { path: "bin.dat" });
    expect(out).toMatch(/^错误: /);
  });
  it("超 512KB 拒绝", async () => {
    writeFileSync(path.join(ws, "big.txt"), "x".repeat(512 * 1024 + 1));
    const out = await tool("read_file").execute(ctx(), { path: "big.txt" });
    expect(out).toMatch(/^错误: /);
  });
});

describe("write_file", () => {
  it("写入并自动建父目录", async () => {
    const out = await tool("write_file").execute(ctx(), {
      path: "d1/d2/n.txt",
      content: "hi",
    });
    expect(out).toContain("已写入");
    expect(readFileSync(path.join(ws, "d1", "d2", "n.txt"), "utf8")).toBe("hi");
  });
  it("覆盖已有文件", async () => {
    await tool("write_file").execute(ctx(), { path: "a.txt", content: "new" });
    expect(readFileSync(path.join(ws, "a.txt"), "utf8")).toBe("new");
  });
  it("超 1MB 拒绝", async () => {
    const out = await tool("write_file").execute(ctx(), {
      path: "big.txt",
      content: "x".repeat(1024 * 1024 + 1),
    });
    expect(out).toMatch(/^错误: /);
  });
});

describe("list_dir", () => {
  it("一层列表，目录在前，忽略隐藏与点开头", async () => {
    writeFileSync(path.join(ws, ".hidden"), "x");
    const out = await tool("list_dir").execute(ctx(), { path: "" });
    expect(out).toContain("sub/");
    expect(out).toContain("a.txt");
    expect(out.indexOf("sub/")).toBeLessThan(out.indexOf("a.txt"));
    expect(out).not.toContain(".hidden");
  });
});

describe("search_files", () => {
  it("content 模式带路径行号", async () => {
    const out = await tool("search_files").execute(ctx(), {
      pattern: "const",
      output_mode: "content",
    });
    expect(out).toContain("sub/b.ts:1:");
  });
  it("files_with_matches 只列文件", async () => {
    const out = await tool("search_files").execute(ctx(), {
      pattern: "const",
      output_mode: "files_with_matches",
    });
    expect(out.trim()).toBe("sub/b.ts");
  });
  it("glob 过滤", async () => {
    writeFileSync(path.join(ws, "c.md"), "const z = 3;");
    const out = await tool("search_files").execute(ctx(), {
      pattern: "const",
      glob: "*.ts",
      output_mode: "files_with_matches",
    });
    expect(out).toContain("b.ts");
    expect(out).not.toContain("c.md");
  });
  it("排除 node_modules", async () => {
    const out = await tool("search_files").execute(ctx(), {
      pattern: "line",
      output_mode: "files_with_matches",
    });
    expect(out).not.toContain("node_modules");
  });
  it("非法正则 → 错误字符串", async () => {
    const out = await tool("search_files").execute(ctx(), {
      pattern: "([",
      output_mode: "files_with_matches",
    });
    expect(out).toMatch(/^错误: /);
  });
});

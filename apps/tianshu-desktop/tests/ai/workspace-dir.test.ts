import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listWorkspaceDir } from "../../electron/domains/ai/chat/workspace-dir";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ws-dir-test-"));
  await mkdir(path.join(root, "alpha"));
  await mkdir(path.join(root, "beta"));
  await writeFile(path.join(root, "beta", "app.js"), "console.log(1)");
  await writeFile(path.join(root, "readme.md"), "hi");
  await writeFile(path.join(root, ".hidden"), "x");
  await mkdir(path.join(root, "beta", ".git"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("listWorkspaceDir", () => {
  it("根目录：目录优先、自然序、隐藏项过滤", async () => {
    const entries = await listWorkspaceDir(root, "");
    expect(entries.map((e) => e.name)).toEqual(["alpha", "beta", "readme.md"]);
    expect(entries[0].isDir).toBe(true);
    expect(entries[2]).toMatchObject({ isDir: false, name: "readme.md" });
    expect(entries[2].size).toBe(2);
    expect(entries[2].mtime).toBeGreaterThan(0);
  });

  it("子目录相对路径", async () => {
    const entries = await listWorkspaceDir(root, "beta");
    expect(entries.map((e) => e.name)).toEqual(["app.js"]);
  });

  it("越界路径抛 PATH_OUTSIDE_WORKSPACE", async () => {
    await expect(listWorkspaceDir(root, "../")).rejects.toThrow(
      "PATH_OUTSIDE_WORKSPACE",
    );
    await expect(listWorkspaceDir(root, "/etc")).rejects.toThrow(
      "PATH_OUTSIDE_WORKSPACE",
    );
  });

  it("绝对路径逃逸（..拼接）同样拒绝", async () => {
    await expect(listWorkspaceDir(root, "alpha/../../")).rejects.toThrow(
      "PATH_OUTSIDE_WORKSPACE",
    );
  });

  it("不存在的目录抛 ENOENT 中文可读错误", async () => {
    await expect(listWorkspaceDir(root, "nope")).rejects.toThrow();
  });
});

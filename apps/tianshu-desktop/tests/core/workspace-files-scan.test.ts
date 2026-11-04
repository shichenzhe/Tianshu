// core 共享纯函数（FA-T1）：workspace 文件扫描 + 守卫读取——mirror 与
// 无头端 files 端点同口径消费（spec 假设 2 裁定：收编 core 防双份漂移）。
// 真实 fs（mkdtemp 隔离）——vitest include 约束落 tests/core/。
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  listWorkspaceFiles,
  readTextFileGuarded,
} from "../../packages/tianshu-core/src/workspace-files-scan";

describe("listWorkspaceFiles", () => {
  it("相对路径枚举：排除 node_modules/dist/点开头，/ 分隔", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wfscan-"));
    writeFileSync(path.join(root, "a.ts"), "x");
    mkdirSync(path.join(root, "sub"));
    writeFileSync(path.join(root, "sub", "b.md"), "y");
    mkdirSync(path.join(root, "node_modules"));
    writeFileSync(path.join(root, "node_modules", "skip.js"), "x");
    mkdirSync(path.join(root, "dist"));
    writeFileSync(path.join(root, "dist", "x.js"), "x");
    writeFileSync(path.join(root, ".hidden"), "x");
    expect(await listWorkspaceFiles(root)).toEqual(["a.ts", "sub/b.md"]);
  });

  it("上限可注（maxEntries 截断）", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wfscan-cap-"));
    for (let i = 0; i < 5; i += 1) {
      writeFileSync(path.join(root, `f${i}.txt`), "x");
    }
    expect((await listWorkspaceFiles(root, { maxEntries: 3 })).length).toBe(3);
  });

  it("根不存在 → 空清单不抛", async () => {
    expect(
      await listWorkspaceFiles(path.join(os.tmpdir(), "wfscan-none-xyz")),
    ).toEqual([]);
  });
});

describe("readTextFileGuarded", () => {
  it("文本 ok；超限 too-large（stat 与读后双检）；NUL binary；不存在 read-failed", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wfread-"));
    const p = path.join(root, "t.txt");
    writeFileSync(p, "hello");
    expect(await readTextFileGuarded(p)).toEqual({
      ok: true,
      content: "hello",
    });
    expect(await readTextFileGuarded(p, 2)).toEqual({
      ok: false,
      reason: "too-large",
    });
    const bin = path.join(root, "b.bin");
    writeFileSync(bin, Buffer.from([0x01, 0x00, 0x02]));
    expect(await readTextFileGuarded(bin)).toEqual({
      ok: false,
      reason: "binary",
    });
    expect(await readTextFileGuarded(path.join(root, "none"))).toEqual({
      ok: false,
      reason: "read-failed",
    });
  });
});

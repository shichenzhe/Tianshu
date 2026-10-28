import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  gitFileDiff,
  gitWorkingChanges,
  type GitExec,
} from "../../electron/domains/ai/chat/git-changes";

/** 按命令前缀路由的 fake git */
function fakeGit(routes: Record<string, string | Error>): GitExec & {
  calls: Array<{ args: string[]; cwd: string }>;
} {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const exec = async (args: string[], cwd: string) => {
    calls.push({ args, cwd });
    const key = args.join(" ");
    const hit = Object.entries(routes).find(([prefix]) =>
      key.startsWith(prefix),
    )?.[1];
    if (hit === undefined) throw new Error(`unexpected: ${key}`);
    if (hit instanceof Error) throw hit;
    return hit;
  };
  return Object.assign(exec, { calls });
}

describe("gitWorkingChanges", () => {
  it("非 git 目录返回 not-git", async () => {
    const exec = fakeGit({
      "rev-parse --is-inside-work-tree": "false\n",
    });
    expect(await gitWorkingChanges("/ws", exec)).toEqual({ kind: "not-git" });
    expect(exec.calls[0].cwd).toBe("/ws");
  });

  it("rev-parse 抛错（无 git）同 not-git", async () => {
    const exec = fakeGit({
      "rev-parse": new Error("not a git repository"),
    });
    expect(await gitWorkingChanges("/ws", exec)).toEqual({ kind: "not-git" });
  });

  it("porcelain -z 解析：staged/unstaged/untracked/重命名", async () => {
    // R17：porcelain -z 条目以 NUL 结尾；重命名为「R  新路径\0旧路径」
    const z = [
      "M  a.ts",
      " M b.ts",
      "A  new.ts",
      "D  gone.ts",
      "R  renamed.ts\0old.ts",
      "?? untracked.ts",
    ].join("\0");
    const exec = fakeGit({
      "rev-parse --is-inside-work-tree": "true\n",
      "status --porcelain": z,
    });
    const out = await gitWorkingChanges("/ws", exec);
    if (out.kind !== "ok") throw new Error("expect ok");
    expect(out.files).toEqual([
      { path: "a.ts", status: "modified", staged: true },
      { path: "b.ts", status: "modified", staged: false },
      { path: "new.ts", status: "added", staged: true },
      { path: "gone.ts", status: "deleted", staged: true },
      { path: "renamed.ts", status: "renamed", staged: true },
      { path: "untracked.ts", status: "untracked", staged: false },
    ]);
    expect(out.truncated).toBe(false);
  });

  it("列表超 500 截断并标记", async () => {
    const z = Array.from({ length: 520 }, (_, i) => `M  f${i}.ts`).join("\0");
    const exec = fakeGit({
      "rev-parse --is-inside-work-tree": "true\n",
      "status --porcelain": z,
    });
    const out = await gitWorkingChanges("/ws", exec);
    if (out.kind !== "ok") throw new Error("expect ok");
    expect(out.files).toHaveLength(500);
    expect(out.truncated).toBe(true);
  });
});

describe("gitFileDiff", () => {
  // resolveSafePath 对 cwd 做 realpathSync（目录须真实存在），fake git 不触盘：
  // brief 的 /ws 在本机不存在（会 ENOENT），改用临时目录（环境性最小偏离）
  let diffCwd = "";
  afterEach(async () => {
    if (diffCwd) {
      await fs.rm(diffCwd, { recursive: true, force: true });
      diffCwd = "";
    }
  });
  const makeTempWorkspace = async () => {
    diffCwd = await fs.mkdtemp(path.join(os.tmpdir(), "git-changes-test-"));
    return diffCwd;
  };

  it("untracked（diff 空）返回 untracked", async () => {
    const ws = await makeTempWorkspace();
    const exec = fakeGit({ "diff --no-color HEAD --": "" });
    expect(await gitFileDiff(ws, "new.ts", exec)).toEqual({
      kind: "untracked",
    });
  });

  it("正常 diff 返回文本；64KB 截断标记", async () => {
    const ws = await makeTempWorkspace();
    const small = fakeGit({
      "diff --no-color HEAD --": "diff --git a/x b/x\n+hello",
    });
    const out1 = await gitFileDiff(ws, "x.ts", small);
    if (out1.kind !== "diff") throw new Error("expect diff");
    expect(out1.text).toContain("+hello");
    expect(out1.truncated).toBe(false);
    const big = fakeGit({
      "diff --no-color HEAD --": "x".repeat(70 * 1024),
    });
    const out2 = await gitFileDiff(ws, "x.ts", big);
    if (out2.kind !== "diff") throw new Error("expect diff");
    expect(out2.text.length).toBeLessThanOrEqual(70 * 1024);
    expect(out2.truncated).toBe(true);
  });

  it("越界 path 抛 PATH_OUTSIDE_WORKSPACE（不执行 git）", async () => {
    const ws = await makeTempWorkspace();
    const exec = fakeGit({});
    await expect(gitFileDiff(ws, "../etc", exec)).rejects.toThrow(
      "PATH_OUTSIDE_WORKSPACE",
    );
    expect(exec.calls).toHaveLength(0);
  });
});

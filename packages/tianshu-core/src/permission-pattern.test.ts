/** 参数级审批 pattern 匹配（skills-tools-mcp §6-6 / security P1-3）：
 *  toolPermission 行 pattern 列（如 bash 的 `git *`、write 的 `src/**`）
 *  的命中判定单测——安全红线：前缀/glob 语义不得跨命令边界或分隔符意外
 *  扩大（`git *` 不得覆盖 `git push; rm -rf /`——管道/分号后的新命令、
 *  命令替换、重定向一律不命中，防记忆面放宽被注入利用） */
import { describe, expect, it } from "vitest";
import {
  isRememberedPermission,
  matchPermissionPattern,
  suggestRememberPattern,
} from "./permission-pattern";

describe("matchPermissionPattern（bash 命令前缀）", () => {
  const bash = (command: string) => ({ command });

  it("首 token 前缀命中：`git *` 命中 git push", () => {
    expect(matchPermissionPattern("git *", "bash", bash("git push"))).toBe(
      true,
    );
  });

  it("多 token 前缀命中：`git push *` 命中 git push --force origin main", () => {
    expect(
      matchPermissionPattern("git push *", "bash", bash("git push --force")),
    ).toBe(true);
  });

  it("不命中其他程序：`git *` 不命中 rm -rf /", () => {
    expect(matchPermissionPattern("git *", "bash", bash("rm -rf /"))).toBe(
      false,
    );
  });

  it("无通配尾为精确 token 序列：`git status` 不命中 git status --short", () => {
    expect(
      matchPermissionPattern("git status", "bash", bash("git status --short")),
    ).toBe(false);
    expect(
      matchPermissionPattern("git status", "bash", bash("git status")),
    ).toBe(true);
  });

  it("多出的前缀 token 不命中：`git push origin *` 不命中 git push", () => {
    expect(
      matchPermissionPattern("git push origin *", "bash", bash("git push")),
    ).toBe(false);
  });

  // —— 安全红线：`*` 不得匹配管道/分号后的新命令 ——
  it("管道链不命中：`git *` 不命中 `git push | sh`", () => {
    expect(matchPermissionPattern("git *", "bash", bash("git push | sh"))).toBe(
      false,
    );
  });

  it("顺序链不命中：`git *` 不命中 `git push; rm -rf /`（分号）", () => {
    expect(
      matchPermissionPattern("git *", "bash", bash("git push; rm -rf /")),
    ).toBe(false);
  });

  it("条件链不命中：`git *` 不命中 `git fetch && rm -rf /`", () => {
    expect(
      matchPermissionPattern("git *", "bash", bash("git fetch && rm -rf /")),
    ).toBe(false);
  });

  it("换行链不命中：`git *` 不命中多行命令", () => {
    expect(
      matchPermissionPattern("git *", "bash", bash("git fetch\nrm -rf /")),
    ).toBe(false);
  });

  it("重定向不命中：`git *` 不命中 `git log > /etc/hosts`", () => {
    expect(
      matchPermissionPattern("git *", "bash", bash("git log > /etc/hosts")),
    ).toBe(false);
  });

  it("命令替换不命中：反引号与 $( ) 均拒绝", () => {
    expect(
      matchPermissionPattern("git *", "bash", bash("git `rm -rf /`")),
    ).toBe(false);
    expect(
      matchPermissionPattern("git *", "bash", bash("git $(rm -rf /)")),
    ).toBe(false);
  });

  it("前缀引号剥离：`git *` 命中带引号参数的 git commit -m \"x\"", () => {
    expect(
      matchPermissionPattern("git *", "bash", bash('git commit -m "fix"')),
    ).toBe(true);
  });

  it("非 bash 工具的 pattern 不命中（即便命令字面相同）", () => {
    expect(matchPermissionPattern("git *", "write", bash("git push"))).toBe(
      false,
    );
  });

  it("空 pattern / 缺 command / 空命令不命中", () => {
    expect(matchPermissionPattern("  ", "bash", bash("git push"))).toBe(false);
    expect(matchPermissionPattern("git *", "bash", {})).toBe(false);
    expect(matchPermissionPattern("git *", "bash", bash("  "))).toBe(false);
  });

  it("中间 token 的 * 不允许（保守——仅尾 token 通配）", () => {
    expect(
      matchPermissionPattern("git * push", "bash", bash("git foo push")),
    ).toBe(false);
  });
});

describe("matchPermissionPattern（write/rm 路径 glob）", () => {
  const write = (path: string) => ({ path });

  it("目录前缀命中：`src/**` 命中 src/a.ts 与 src/x/y.ts", () => {
    expect(matchPermissionPattern("src/**", "write", write("src/a.ts"))).toBe(
      true,
    );
    expect(
      matchPermissionPattern("src/**", "write", write("src/x/y.ts")),
    ).toBe(true);
  });

  it("段内 * 不跨分隔符：`*.ts` 命中 a.ts 不命中 src/a.ts", () => {
    expect(matchPermissionPattern("*.ts", "write", write("a.ts"))).toBe(true);
    expect(matchPermissionPattern("*.ts", "write", write("src/a.ts"))).toBe(
      false,
    );
  });

  it("越界前缀不命中：`src/**` 不命中 docs/a.ts 与 srca.ts", () => {
    expect(matchPermissionPattern("src/**", "write", write("docs/a.ts"))).toBe(
      false,
    );
    expect(matchPermissionPattern("src/**", "write", write("srca.ts"))).toBe(
      false,
    );
  });

  it("无通配为精确路径：`a.txt` 只命中 a.txt", () => {
    expect(matchPermissionPattern("a.txt", "write", write("a.txt"))).toBe(true);
    expect(matchPermissionPattern("a.txt", "write", write("b/a.txt"))).toBe(
      false,
    );
  });

  it("? 单字符通配段内生效", () => {
    expect(matchPermissionPattern("a?.ts", "write", write("ab.ts"))).toBe(true);
    expect(matchPermissionPattern("a?.ts", "write", write("abc.ts"))).toBe(
      false,
    );
  });

  it("相对逃逸段不命中：`..` 与 `.` 段拒绝", () => {
    expect(
      matchPermissionPattern("**", "write", write("../outside/a.ts")),
    ).toBe(false);
    expect(
      matchPermissionPattern("src/**", "write", write("src/../docs/a.ts")),
    ).toBe(false);
  });

  it("绝对路径不命中（仅工作空间相对声明可匹配）", () => {
    expect(
      matchPermissionPattern("**", "write", write("/etc/passwd")),
    ).toBe(false);
    expect(matchPermissionPattern("**", "write", write("C:\\x\\y.ts"))).toBe(
      false,
    );
  });

  it("./ 前缀归一：`src/**` 命中 ./src/a.ts", () => {
    expect(matchPermissionPattern("src/**", "write", write("./src/a.ts"))).toBe(
      true,
    );
  });

  it("rm 同 write 语义；其余工具保守不命中", () => {
    expect(matchPermissionPattern("src/**", "rm", write("src/a"))).toBe(true);
    expect(
      matchPermissionPattern("src/**", "ls", write("src/a")),
    ).toBe(false);
    expect(
      matchPermissionPattern("{}", "mcp__srv__tool", { any: "thing" }),
    ).toBe(false);
  });
});

describe("suggestRememberPattern（审批横幅前缀建议）", () => {
  it("bash 取首 token：git push --force → `git *`", () => {
    expect(
      suggestRememberPattern("bash", { command: "git push --force" }),
    ).toBe("git *");
  });

  it("bash 命令含元字符不提供前缀选项（防误扩）", () => {
    expect(
      suggestRememberPattern("bash", { command: "git fetch && rm -rf /" }),
    ).toBeNull();
  });

  it("write/rm 取目录前缀：src/x/a.ts → `src/x/**`；目录目标取其父目录", () => {
    expect(suggestRememberPattern("write", { path: "src/x/a.ts" })).toBe(
      "src/x/**",
    );
    expect(suggestRememberPattern("rm", { path: "src/old" })).toBe("src/**");
  });

  it("根级文件无目录前缀：a.txt → null（不提供前缀选项）", () => {
    expect(suggestRememberPattern("write", { path: "a.txt" })).toBeNull();
  });

  it("其余工具不提供前缀选项", () => {
    expect(suggestRememberPattern("mcp__srv__tool", { a: 1 })).toBeNull();
  });
});

describe("isRememberedPermission（记忆查表 + lastUsedAt 回写）", () => {
  const makeDb = (rows: Array<{ id: number; pattern: string | null }>) => {
    const updates: Array<{ id: number; lastUsedAt: Date }> = [];
    return {
      updates,
      db: {
        toolPermission: {
          findMany: async () => rows,
          update: async (args: { where: { id: number }; data: unknown }) => {
            const { id } = args.where;
            updates.push({ id, lastUsedAt: (args.data as { lastUsedAt: Date }).lastUsedAt });
            return {};
          },
        },
      },
    };
  };

  it("无 pattern 行（旧全等语义）：任意参数命中——行为与旧全等一致", async () => {
    const { db, updates } = makeDb([{ id: 7, pattern: null }]);
    expect(
      await isRememberedPermission(db, 1, "bash", { command: "anything" }),
    ).toBe(true);
    expect(await isRememberedPermission(db, 1, "bash", {})).toBe(true);
    expect(updates.map((u) => u.id)).toEqual([7, 7]);
  });

  it("pattern 行：命中参数匹配，未命中参数不命中", async () => {
    const { db, updates } = makeDb([{ id: 9, pattern: "git *" }]);
    expect(
      await isRememberedPermission(db, 1, "bash", { command: "git push" }),
    ).toBe(true);
    expect(
      await isRememberedPermission(db, 1, "bash", { command: "rm -rf /" }),
    ).toBe(false);
    expect(updates.map((u) => u.id)).toEqual([9]);
  });

  it("多行混合：pattern 行未命中时继续看无 pattern 行（宽行兜底）", async () => {
    const { db } = makeDb([
      { id: 1, pattern: "git *" },
      { id: 2, pattern: null },
    ]);
    expect(
      await isRememberedPermission(db, 1, "bash", { command: "npm i" }),
    ).toBe(true);
  });

  it("无 workspaceId（未绑定/无任务）恒 false", async () => {
    const { db } = makeDb([{ id: 1, pattern: null }]);
    expect(await isRememberedPermission(db, null, "bash", {})).toBe(false);
    expect(await isRememberedPermission(db, undefined, "bash", {})).toBe(false);
  });

  it("空行集不命中、lastUsedAt 回写失败不影响判定（fire-and-forget）", async () => {
    const db = {
      toolPermission: {
        findMany: async () => [{ id: 3, pattern: null }],
        update: async () => {
          throw new Error("db locked");
        },
      },
    };
    expect(await isRememberedPermission(db, 1, "write", { path: "a" })).toBe(
      true,
    );
  });
});

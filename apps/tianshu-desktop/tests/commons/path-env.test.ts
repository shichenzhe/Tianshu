import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  fixPathForGuiProcess,
  isValidPathValue,
  mergePathEntries,
} from "../../electron/commons/path-env";

describe("isValidPathValue", () => {
  it("纯路径段合法（允许空段）", () => {
    expect(isValidPathValue("/usr/bin:/bin")).toBe(true);
    expect(isValidPathValue("/opt/homebrew/bin::/usr/bin")).toBe(true);
  });
  it("空值与 shell 启动杂音拒绝", () => {
    expect(isValidPathValue("")).toBe(false);
    expect(isValidPathValue("Welcome to zsh\n/opt/homebrew/bin")).toBe(false);
    expect(isValidPathValue("usr/bin:/bin")).toBe(false);
  });
});

describe("mergePathEntries", () => {
  it("探测量在前、原值兜底，去重保序", () => {
    expect(
      mergePathEntries("/opt/homebrew/bin:/usr/bin", "/usr/bin:/bin"),
    ).toBe("/opt/homebrew/bin:/usr/bin:/bin");
  });
  it("空段忽略", () => {
    expect(mergePathEntries(":/usr/bin", "/usr/bin")).toBe("/usr/bin");
  });
});

describe("fixPathForGuiProcess（真实 shell，unix only）", () => {
  const originalPath = process.env.PATH;
  const originalShell = process.env.SHELL;

  afterEach(() => {
    process.env.PATH = originalPath;
    process.env.SHELL = originalShell;
  });

  it.runIf(process.platform !== "win32")(
    "登录 shell PATH 被前置合并且无重复",
    () => {
      process.env.SHELL = "/bin/bash";
      fixPathForGuiProcess();
      const segments = (process.env.PATH ?? "").split(":");
      expect(segments).toContain("/usr/bin");
      expect(new Set(segments).size).toBe(segments.length);
    },
  );

  it.runIf(process.platform !== "win32")(
    "SHELL 不存在时保留原 PATH（fail-safe）",
    () => {
      process.env.SHELL = "/nonexistent/shell";
      fixPathForGuiProcess();
      expect(process.env.PATH).toBe(originalPath);
    },
  );

  it.runIf(process.platform !== "win32")(
    "shell 启动杂音输出被拒绝，PATH 不变",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "path-env-"));
      const noisyShell = path.join(dir, "noisy-shell");
      await writeFile(
        noisyShell,
        "#!/bin/sh\necho 'welcome text'\necho /opt/fake/bin\n",
        "utf-8",
      );
      await chmod(noisyShell, 0o755);
      process.env.SHELL = noisyShell;
      fixPathForGuiProcess();
      expect(process.env.PATH).toBe(originalPath);
    },
  );
});

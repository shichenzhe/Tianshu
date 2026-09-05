import { exec } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ exec: vi.fn() }));

import {
  isDangerousCommand,
  makeRunCommandTool,
} from "../../electron/domains/ai/agent/command-tool";

/** exec 回调签名（放宽 code 为 number | null 以模拟超时态） */
type ExecCallback = (
  error: (Error & { code?: number | null; killed?: boolean }) | null,
  stdout: string,
  stderr: string,
) => void;

type ExecOptionsShape = { cwd?: string; timeout?: number; maxBuffer?: number };

const mockExec = vi.mocked(exec);

/** 注入可控的 exec 假实现：同步回调吐出预设结果 */
function fakeExec(result: {
  error?: Error & { code?: number | null; killed?: boolean };
  stdout?: string;
  stderr?: string;
}): void {
  mockExec.mockImplementation(((
    _command: string,
    _options: ExecOptionsShape,
    cb: ExecCallback,
  ) => {
    cb(result.error ?? null, result.stdout ?? "", result.stderr ?? "");
    return undefined;
  }) as unknown as typeof exec);
}

function lastCall(): [string, ExecOptionsShape, ExecCallback] {
  const calls = mockExec.mock.calls;
  return calls[calls.length - 1] as unknown as [
    string,
    ExecOptionsShape,
    ExecCallback,
  ];
}

const DANGEROUS: string[] = [
  "rm -rf /",
  "rm -rf /Users",
  "rm -fr /",
  "sudo rm -r /tmp/../",
  "mkfs.ext4 /dev/sda1",
  "mkfs /anything",
  "dd if=x of=/dev/disk0",
  ":(){ :|: & };:",
  ":(){:|:&};:",
  "chmod -R 777 /",
];

const SAFE: string[] = [
  "rm -rf ./node_modules",
  "rm -r dist",
  "rm file.txt",
  "dd if=a of=b.img",
  "chmod -R 777 ./x",
  "ls -la",
  "echo hi",
  "npm install",
];

let ws: string;
const tool = makeRunCommandTool();
const defaultCtx = () => ({ workspacePath: ws, sessionId: 1 });
const fullCtx = () => ({ workspacePath: ws, sessionId: 1, fullAccess: true });

beforeEach(() => {
  ws = mkdtempSync(path.join(os.tmpdir(), "cmd-ws-"));
  mkdirSync(path.join(ws, "sub"));
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

describe("isDangerousCommand 拦截矩阵", () => {
  it.each(DANGEROUS)("拦截高危命令: %s", (cmd) => {
    expect(isDangerousCommand(cmd)).toBe(true);
  });
  it.each(SAFE)("放行常规命令: %s", (cmd) => {
    expect(isDangerousCommand(cmd)).toBe(false);
  });
});

describe("run_command execute", () => {
  // 注：箭头体必须加大括号——mockClear 返回 mock 本身，会被 Vitest 误认为
  // hook 清理函数而在 afterEach 以零参调用（回调签名即崩）
  beforeEach(() => {
    mockExec.mockClear();
  });

  it("退出码 0 → 成功串，cwd=工作空间根且带 timeout/maxBuffer", async () => {
    fakeExec({ stdout: "hello\n" });
    const out = await tool.execute(defaultCtx(), { command: "echo hi" });
    expect(out).toBe("退出码 0\nhello\n");
    const [cmd, opts] = lastCall();
    expect(cmd).toBe("echo hi");
    expect(opts.cwd).toBe(ws);
    expect(opts.timeout).toBe(60_000);
    expect(opts.maxBuffer).toBe(1024 * 1024);
  });

  it("非零退出码 → 错误串含退出码与 stdout/stderr 合并输出", async () => {
    const error = Object.assign(new Error("Command failed"), { code: 2 });
    fakeExec({ error, stdout: "partial out", stderr: "err line" });
    const out = await tool.execute(defaultCtx(), { command: "failing-cmd" });
    expect(out).toBe("错误: 命令失败（退出码 2）\npartial out\nerr line");
  });

  it("killed 超时 → 错误串带/超时标记", async () => {
    const error = Object.assign(new Error("spawn timeout"), {
      killed: true,
      code: null,
    });
    fakeExec({ error, stdout: "", stderr: "terminated" });
    const out = await tool.execute(defaultCtx(), { command: "sleep 999" });
    expect(out).toBe("错误: 命令失败（退出码 -/超时）\nterminated");
  });

  it("输出超 8KB 截断并追加标记", async () => {
    fakeExec({ stdout: "x".repeat(9000) });
    const out = await tool.execute(defaultCtx(), { command: "big-output" });
    expect(out.startsWith("退出码 0\n")).toBe(true);
    expect(out.endsWith("…（已截断）")).toBe(true);
    expect(out.length).toBeLessThan(9000);
  });

  it("default 态 cwd 越界回退工作空间根，界内相对路径正常解析", async () => {
    fakeExec({ stdout: "ok" });
    await tool.execute(defaultCtx(), { command: "ls", cwd: "../../etc" });
    expect(lastCall()[1].cwd).toBe(ws);
    await tool.execute(defaultCtx(), { command: "ls", cwd: "sub" });
    expect(lastCall()[1].cwd).toBe(path.join(ws, "sub"));
  });

  it("fullAccess 态 cwd 任意直传，未传时不回退工作空间根", async () => {
    fakeExec({ stdout: "ok" });
    await tool.execute(fullCtx(), { command: "ls", cwd: "/tmp/elsewhere" });
    expect(lastCall()[1].cwd).toBe("/tmp/elsewhere");
    await tool.execute(fullCtx(), { command: "ls" });
    expect(lastCall()[1].cwd).toBeUndefined();
  });

  it("危险命令拦截优先于执行（exec 不被调用）", async () => {
    fakeExec({ stdout: "should-not-run" });
    const out = await tool.execute(fullCtx(), { command: "rm -rf /" });
    expect(out).toBe("错误: 该命令被安全策略拦截（高风险破坏性操作）");
    expect(mockExec).not.toHaveBeenCalled();
  });
});

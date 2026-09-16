import { exec, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// execFile：command-tool 传递依赖 child-monitor 顶层 promisify 需要
// （本文件不触子进程监控，watchCommandTree 不被调用）
vi.mock("node:child_process", () => ({ exec: vi.fn(), execFile: vi.fn() }));
// network-gate 传递依赖 Log（→ electron，终审 S2），经 vi.mock 替换
vi.mock("../../electron/commons/Log", () => ({
  default: { error: vi.fn() },
}));

import {
  isDangerousCommand,
  makeRunCommandTool,
} from "../../electron/domains/ai/agent/command-tool";

/** exec 回调签名（code 放宽为 number/string/null：数值退出码、错误码串、超时 null） */
type ExecCallback = (
  error: (Error & { code?: number | string | null; killed?: boolean }) | null,
  stdout: string,
  stderr: string,
) => void;

type ExecOptionsShape = { cwd?: string; timeout?: number; maxBuffer?: number };

const mockExec = vi.mocked(exec);

/** 注入可控的 exec 假实现：同步回调吐出预设结果
 * （SP2 起真实契约须返回 ChildProcess——runExec 透出 child.pid 供监控挂载；
 * 无黑名单时 startChildWatch 直接跳过，不触 watchCommandTree） */
function fakeExec(result: {
  error?: Error & { code?: number | string | null; killed?: boolean };
  stdout?: string;
  stderr?: string;
}): void {
  mockExec.mockImplementation(((
    _command: string,
    _options: ExecOptionsShape,
    cb: ExecCallback,
  ) => {
    cb(result.error ?? null, result.stdout ?? "", result.stderr ?? "");
    return { pid: 4321 } as ChildProcess;
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
  'rm -rf "/Users/foo/bar"',
  "rm -rf '/Users'",
  "rm -rf ~",
  "rm -rf ~/*",
  "rm -rf $HOME",
  'rm -rf "$HOME/lib"',
  // 终审 I1 等价类补丁：转义/长旗标/花括号变量
  "rm -rf \\/",
  "rm -rf \\/Users",
  "rm --recursive --force /",
  "rm --recursive /",
  'rm -rf "${HOME}/x"',
  "chmod --recursive 777 /",
  // 同族补刀：大写 R 与前置带连字符长旗标
  "rm -R /",
  "rm -Rf /Users",
  "rm --no-preserve-root -rf /",
  "mkfs.ext4 /dev/sda1",
  "mkfs /anything",
  "dd if=x of=/dev/disk0",
  ":(){ :|: & };:",
  ":(){:|:&};:",
  "chmod -R 777 /",
  "chmod -R 777 /Users",
  "chmod -R 777 '~/x'",
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
  // 长旗标的相对路径形态不误伤
  "rm --recursive ./dist",
  "chmod --recursive 755 ./x",
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

  it("maxBuffer 溢出 → 标注输出超限且保留已捕获输出（经 8KB 截断）", async () => {
    // 真实 Node 中溢出错误 killed 亦为 true——验证 maxBuffer 判定优先于超时
    const byCode = Object.assign(new Error("stdout maxBuffer exceeded"), {
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      killed: true,
    });
    fakeExec({ error: byCode, stdout: "y".repeat(1024 * 1024 + 1) });
    const out = await tool.execute(defaultCtx(), { command: "npm install" });
    expect(out.startsWith("错误: 命令失败（退出码 -/输出超限）\n")).toBe(true);
    expect(out.endsWith("…（已截断）")).toBe(true);
    // 旧版 Node 无错误码，仅 message 含 maxBuffer
    const byMessage = Object.assign(
      new Error("stdout maxBuffer length exceeded"),
      {
        killed: true,
      },
    );
    fakeExec({ error: byMessage, stdout: "captured tail" });
    const out2 = await tool.execute(defaultCtx(), { command: "npm install" });
    expect(out2).toBe("错误: 命令失败（退出码 -/输出超限）\ncaptured tail");
  });

  it("spawn 级失败（字符串错误码）→ 命令启动失败且不带输出", async () => {
    const error = Object.assign(new Error("spawn npm ENOMEM"), {
      code: "ENOMEM",
    });
    fakeExec({ error, stdout: "leak", stderr: "leak" });
    const out = await tool.execute(defaultCtx(), { command: "npm install" });
    expect(out).toBe("错误: 命令启动失败（spawn npm ENOMEM）");
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

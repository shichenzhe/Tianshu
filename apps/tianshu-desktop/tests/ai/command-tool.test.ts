import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// execFile：command-tool 传递依赖 child-monitor 顶层 promisify 需要
// （本文件不触子进程监控，watchCommandTree 不被调用）；spawn：OS 沙箱批
// 起 runExec 改 spawn("/bin/sh",["-c"]) 自建进程组（exec 丢 detached），
// 测试 mock 已对齐 spawn 契约（此前停留在 exec 回调形态致 9 用例红）
vi.mock("node:child_process", () => ({
  exec: vi.fn(),
  execFile: vi.fn(),
  spawn: vi.fn(),
}));
// network-gate 传递依赖 Log（→ electron，终审 S2），经 vi.mock 替换
vi.mock("../../electron/commons/Log", () => ({
  default: { error: vi.fn() },
}));

import {
  isDangerousCommand,
  makeRunCommandTool,
} from "../../electron/domains/ai/agent/command-tool";

type SpawnOptionsShape = { cwd?: string; timeout?: number };
type SpawnCall = [string, string[], SpawnOptionsShape];

const mockSpawn = vi.mocked(spawn);

/** 伪子进程：stdio 以 EventEmitter 代流（runExec 仅挂 data 监听）；pid
 * 留空——reapProcessGroup 与 startChildWatch 对无 pid 均空转，不真杀进程组 */
interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

/** 注入可控的 spawn 假实现：setImmediate 异步触发事件序列（runExec 在
 * spawn 返回后才注册流与事件监听，必须待注册完毕再 emit）。溢出语义对齐
 * 手工重建的 maxBuffer：先推 baseline 已捕获输出，再推超 1MB chunk 杀流 */
function fakeSpawn(result: {
  error?: Error;
  stdout?: string;
  stderr?: string;
  signal?: NodeJS.Signals;
  exitCode?: number | null;
  overflowBaseline?: string;
}): void {
  mockSpawn.mockImplementation(((
    _cmd: string,
    _args: string[],
    _opts: SpawnOptionsShape,
  ) => {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    setImmediate(() => {
      if (result.error) {
        child.emit("error", result.error);
        return;
      }
      if (result.stdout) {
        child.stdout.emit("data", Buffer.from(result.stdout));
      }
      if (result.stderr) {
        child.stderr.emit("data", Buffer.from(result.stderr));
      }
      if (result.overflowBaseline !== undefined) {
        child.stdout.emit("data", Buffer.from(result.overflowBaseline));
        child.stdout.emit("data", Buffer.alloc(1024 * 1024 + 1));
      }
      const code = result.exitCode ?? 0;
      const signal = result.signal ?? null;
      child.emit("exit", code, signal);
      child.emit("close", code, signal);
    });
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawn);
}

function lastCall(): SpawnCall {
  const calls = mockSpawn.mock.calls;
  return calls[calls.length - 1] as unknown as SpawnCall;
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
  // Windows 递归删除（rd/rmdir/del/erase + /s 旗标，大小写不敏感）
  "rd /s /q C:\\Users",
  "rmdir /s /q D:\\data",
  "del /s /q C:\\*.tmp",
  "del /f /s /q *.log",
  "erase /S logs",
  "cmd /c rd /s /q C:\\",
  // Windows 格式化/磁盘分区
  "format C:",
  "format /FS:NTFS X:",
  "diskpart",
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
  // Windows 族不误伤：无 /s 的删除、format 子命令词、非盘符 format 句
  "del file.txt",
  "del /q *.tmp",
  "rd empty-dir",
  "git format-patch HEAD~2",
  "echo formatted output",
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

describe("bash execute", () => {
  // 注：箭头体必须加大括号——mockClear 返回 mock 本身，会被 Vitest 误认为
  // hook 清理函数而在 afterEach 以零参调用（回调签名即崩）
  beforeEach(() => {
    mockSpawn.mockClear();
  });

  it("退出码 0 → 成功串，经 sh -c 执行且 cwd=工作空间根带 timeout", async () => {
    fakeSpawn({ stdout: "hello\n" });
    const out = await tool.execute(defaultCtx(), { command: "echo hi" });
    expect(out).toBe("退出码 0\nhello\n");
    const [cmd, args, opts] = lastCall();
    expect(cmd).toBe("/bin/sh");
    expect(args).toEqual(["-c", "echo hi"]);
    expect(opts.cwd).toBe(ws);
    expect(opts.timeout).toBe(60_000);
  });

  it("非零退出码 → 错误串含退出码与 stdout/stderr 合并输出", async () => {
    fakeSpawn({ exitCode: 2, stdout: "partial out", stderr: "err line" });
    const out = await tool.execute(defaultCtx(), { command: "failing-cmd" });
    expect(out).toBe("错误: 命令失败（退出码 2）\npartial out\nerr line");
  });

  it("SIGTERM 结算 → 错误串带/超时标记", async () => {
    fakeSpawn({ exitCode: null, signal: "SIGTERM", stderr: "terminated" });
    const out = await tool.execute(defaultCtx(), { command: "sleep 999" });
    expect(out).toBe("错误: 命令失败（退出码 -/超时）\nterminated");
  });

  it("stdout 超 1MB 溢出 → 标注输出超限且保留已捕获输出（经 8KB 截断）", async () => {
    // 溢出 chunk 不入聚合（与 exec 时代 maxBuffer 丢弃语义一致），
    // 已捕获的 9000 字节经 mergeOutput 截 8KB 加标记
    fakeSpawn({ overflowBaseline: "y".repeat(9000) });
    const out = await tool.execute(defaultCtx(), { command: "npm install" });
    expect(out.startsWith("错误: 命令失败（退出码 -/输出超限）\n")).toBe(true);
    expect(out.endsWith("…（已截断）")).toBe(true);
    expect(out.length).toBeLessThan(9000);
  });

  it("spawn 级失败（error 事件）→ 命令启动失败且不带输出", async () => {
    const error = Object.assign(new Error("spawn npm ENOMEM"), {
      code: "ENOMEM",
    });
    fakeSpawn({ error });
    const out = await tool.execute(defaultCtx(), { command: "npm install" });
    expect(out).toBe("错误: 命令启动失败（spawn npm ENOMEM）");
  });

  it("输出超 8KB 截断并追加标记", async () => {
    fakeSpawn({ stdout: "x".repeat(9000) });
    const out = await tool.execute(defaultCtx(), { command: "big-output" });
    expect(out.startsWith("退出码 0\n")).toBe(true);
    expect(out.endsWith("…（已截断）")).toBe(true);
    expect(out.length).toBeLessThan(9000);
  });

  it("default 态 cwd 越界回退工作空间根，界内相对路径正常解析", async () => {
    fakeSpawn({ stdout: "ok" });
    await tool.execute(defaultCtx(), { command: "ls", cwd: "../../etc" });
    expect(lastCall()[2].cwd).toBe(ws);
    await tool.execute(defaultCtx(), { command: "ls", cwd: "sub" });
    expect(lastCall()[2].cwd).toBe(path.join(ws, "sub"));
  });

  it("未绑定目录（空串 workspacePath）default 态以家目录为锚：默认落家、界内解析、越界回退+审计", async () => {
    fakeSpawn({ stdout: "ok" });
    const home = os.homedir();
    const onSecurityEvent = vi.fn();
    const unboundCtx = () => ({
      workspacePath: "",
      sessionId: 1,
      onSecurityEvent,
    });
    // 未传 cwd → 家目录（与终端 tab 无工作空间落家目录同构）
    await tool.execute(unboundCtx(), { command: "ls" });
    expect(lastCall()[2].cwd).toBe(home);
    // 家目录内相对路径正常解析
    await tool.execute(unboundCtx(), { command: "ls", cwd: "Desktop" });
    expect(lastCall()[2].cwd).toBe(path.join(home, "Desktop"));
    // 界外绝对路径回退家目录并上报审计事件
    await tool.execute(unboundCtx(), { command: "ls", cwd: "/etc" });
    expect(lastCall()[2].cwd).toBe(home);
    expect(onSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "command-safety.cwd-fallback",
        decision: "info",
        detail: expect.objectContaining({ fallback: home }),
      }),
    );
  });

  it("fullAccess 态 cwd 任意直传，未传时不回退工作空间根", async () => {
    fakeSpawn({ stdout: "ok" });
    await tool.execute(fullCtx(), { command: "ls", cwd: "/tmp/elsewhere" });
    expect(lastCall()[2].cwd).toBe("/tmp/elsewhere");
    await tool.execute(fullCtx(), { command: "ls" });
    expect(lastCall()[2].cwd).toBeUndefined();
  });

  it("危险命令拦截优先于执行（spawn 不被调用）；删文件类附 rm 指引", async () => {
    fakeSpawn({ stdout: "should-not-run" });
    const out = await tool.execute(fullCtx(), { command: "rm -rf /" });
    expect(out).toBe(
      "错误: 该命令被安全策略拦截（高风险破坏性操作）；删除文件请改用 rm 工具",
    );
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

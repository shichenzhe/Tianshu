import { exec } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { SeatbeltRunner } from "../../electron/domains/security/sandbox/seatbelt";

const execAsync = promisify(exec);

/** darwin 之外整文件跳过（spec §10 平台守卫） */
const itDarwin = process.platform === "darwin" ? it : it.skip;

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-sandbox-ws-"));
}

/** 经 SeatbeltRunner 包装后真跑（cwd=workspace，对齐 runExec 形态） */
async function runInSandbox(
  command: string,
  workspacePath: string,
  fullAccess = false,
): Promise<{ code: number; stderr: string }> {
  const wrapped = SeatbeltRunner.wrap(command, { workspacePath, fullAccess });
  try {
    const { stderr } = await execAsync(wrapped.command, {
      cwd: workspacePath,
      timeout: 15_000,
    });
    return { code: 0, stderr };
  } catch (e) {
    const err = e as { code?: number; stderr?: string };
    return { code: err.code ?? -1, stderr: err.stderr ?? "" };
  }
}

describe("Seatbelt 真跑集成（spec §10）", () => {
  itDarwin("workspace 内写文件成功", async () => {
    const ws = makeWorkspace();
    const { code, stderr } = await runInSandbox(
      `echo ok > ${JSON.stringify(path.join(ws, "inside.txt"))}`,
      ws,
    );
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(ws, "inside.txt"))).toBe(true);
    fs.rmSync(ws, { recursive: true, force: true });
    expect(stderr).toBe("");
  });

  itDarwin("TMPDIR 内写文件成功（写白名单第二锚）", async () => {
    const ws = makeWorkspace();
    const tmpProbe = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "probe-")),
      "t.txt",
    );
    const { code } = await runInSandbox(
      `echo t > ${JSON.stringify(tmpProbe)}`,
      ws,
    );
    expect(code).toBe(0);
    expect(fs.existsSync(tmpProbe)).toBe(true);
  });

  itDarwin("越界写（家目录）被系统拒绝（EPERM）", async () => {
    const ws = makeWorkspace();
    const probe = path.join(os.homedir(), ".tianshu-sandbox-probe");
    const { code, stderr } = await runInSandbox(
      `echo bad > ${JSON.stringify(probe)}`,
      ws,
    );
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/Operation not permitted|EPERM|not permitted/i);
    expect(fs.existsSync(probe)).toBe(false);
  });

  itDarwin("命令替换混淆（静态分析极限形态）越界写仍被拒", async () => {
    const ws = makeWorkspace();
    const probe = path.join(os.homedir(), ".tianshu-sandbox-probe2");
    const { code } = await runInSandbox(
      `echo bad > "$(echo ${JSON.stringify(path.dirname(probe))})/${path.basename(probe)}"`,
      ws,
    );
    expect(code).not.toBe(0);
    expect(fs.existsSync(probe)).toBe(false);
  });

  itDarwin("full 档透传：wrap 恒等返回原命令（裁定假设 #1）", () => {
    const ws = makeWorkspace();
    const wrapped = SeatbeltRunner.wrap("echo hi", {
      workspacePath: ws,
      fullAccess: true,
    });
    expect(wrapped).toEqual({ command: "echo hi", sandboxed: false });
  });

  itDarwin("包装产物形如 sandbox-exec -p <sbpl> /bin/zsh -c <cmd>", () => {
    const ws = makeWorkspace();
    const wrapped = SeatbeltRunner.wrap("echo 'q uote'", {
      workspacePath: ws,
      fullAccess: false,
    });
    expect(wrapped.sandboxed).toBe(true);
    expect(wrapped.command).toMatch(/^sandbox-exec -p '/);
    expect(wrapped.command).toMatch(/\/bin\/zsh -c '/);
    // 含单引号命令无损重建：'echo '\''q uote'\''（外层 sh 解析不破）
    expect(wrapped.command).toContain("/bin/zsh -c 'echo '\\''q uote'\\''");
  });
});

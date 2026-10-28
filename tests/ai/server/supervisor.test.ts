// T15 ServerSupervisor：本地无头端子进程管理（spawn + stdout 握手行扫描 +
// 10s 握手超时 kill + 非零退出 error + stop 优雅杀）。fake 子进程用 node -e
// 内联脚本（brief Step 1 同款），超时窗/stop 窗构造注入缩短避免真等 10s/5s。
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../electron/commons/Log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  ServerSupervisor,
  HANDSHAKE_PREFIX,
} from "../../../electron/domains/server/supervisor";

/** fake 子进程脚本：SIGTERM 处理器先于握手行注册（握手=就绪契约）→
 * 打印握手行后保活；SIGTERM → exit 0（优雅停路径） */
const KEEP_ALIVE_SCRIPT = `
process.on('SIGTERM', () => process.exit(0));
console.log('${HANDSHAKE_PREFIX}${JSON.stringify({
  port: 3999,
  token: "tok-1",
  instanceId: "inst-1",
})}');
setInterval(() => {}, 1000);
`;

describe("ServerSupervisor（fake 子进程）", () => {
  it("握手行解析：start 解析出 port/token/instanceId，state=running", async () => {
    const supervisor = new ServerSupervisor();
    expect(supervisor.state).toBe("stopped");
    const info = await supervisor.start({
      command: process.execPath,
      args: ["-e", KEEP_ALIVE_SCRIPT],
    });
    expect(info).toEqual({
      port: 3999,
      token: "tok-1",
      instanceId: "inst-1",
    });
    expect(supervisor.state).toBe("running");
    await supervisor.stop();
  }, 10_000);

  it("握手行跨 stdout chunk 劈开仍可解析（逐行缓冲）", async () => {
    const line = `${HANDSHAKE_PREFIX}${JSON.stringify({
      port: 4001,
      token: "tok-2",
      instanceId: "inst-2",
    })}`;
    // 劈在 JSON 中段（前 25 字符一写、余段延迟 150ms 补写 + 换行）；
    // SIGTERM 处理器先于握手行注册（同 KEEP_ALIVE 契约）
    const script = `
process.on('SIGTERM', () => process.exit(0));
process.stdout.write(${JSON.stringify(line.slice(0, 25))});
setTimeout(() => process.stdout.write(${JSON.stringify(
      `${line.slice(25)}\n`,
    )}), 150);
setInterval(() => {}, 1000);
`;
    const supervisor = new ServerSupervisor();
    const info = await supervisor.start({
      command: process.execPath,
      args: ["-e", script],
    });
    expect(info).toEqual({
      port: 4001,
      token: "tok-2",
      instanceId: "inst-2",
    });
    await supervisor.stop();
  }, 10_000);

  it("握手超时：10s（注入缩短）无握手行 → kill 子进程、start 拒绝、state=error", async () => {
    const supervisor = new ServerSupervisor({ handshakeTimeoutMs: 400 });
    const exits: Array<{ code: number | null; signal: string | null }> = [];
    supervisor.onExit((info) => exits.push(info));
    await expect(
      supervisor.start({
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 30000)"],
      }),
    ).rejects.toThrow(/握手超时/);
    expect(supervisor.state).toBe("error");
    // 子进程已被 kill（exit 事件到达，signal=SIGKILL 或退出路径等价物）
    await vi.waitFor(() => expect(exits.length).toBe(1));
    expect(exits[0].expected).toBe(false);
    // 超时后可再次 start（state=error 不锁死）
    const info = await supervisor.start({
      command: process.execPath,
      args: ["-e", KEEP_ALIVE_SCRIPT],
    });
    expect(info.port).toBe(3999);
    await supervisor.stop();
  }, 10_000);

  it("握手前非零退出：start 拒绝并带退出码，state=error", async () => {
    const supervisor = new ServerSupervisor();
    await expect(
      supervisor.start({
        command: process.execPath,
        args: ["-e", "process.exit(3)"],
      }),
    ).rejects.toThrow(/退出码 3/);
    expect(supervisor.state).toBe("error");
    await expect(supervisor.stop()).resolves.toBeUndefined();
  }, 10_000);

  it("运行中非零退出：state=error + onExit 通知（unexpected）", async () => {
    const supervisor = new ServerSupervisor();
    await supervisor.start({
      command: process.execPath,
      args: [
        "-e",
        `
console.log('${HANDSHAKE_PREFIX}${JSON.stringify({
          port: 3999,
          token: "tok-1",
          instanceId: "inst-1",
        })}');
setTimeout(() => process.exit(2), 150);
`,
      ],
    });
    expect(supervisor.state).toBe("running");
    const exits: Array<Record<string, unknown>> = [];
    supervisor.onExit((info) => exits.push(info));
    await vi.waitFor(() => expect(supervisor.state).toBe("error"));
    await vi.waitFor(() => expect(exits.length).toBe(1));
    expect(exits[0]).toMatchObject({ code: 2, signal: null, expected: false });
  }, 10_000);

  it("stop 优雅杀：SIGTERM 后子进程 exit 0，state=stopped，onExit(expected)", async () => {
    const supervisor = new ServerSupervisor();
    await supervisor.start({
      command: process.execPath,
      args: ["-e", KEEP_ALIVE_SCRIPT],
    });
    const exits: Array<Record<string, unknown>> = [];
    supervisor.onExit((info) => exits.push(info));
    await supervisor.stop();
    expect(supervisor.state).toBe("stopped");
    await vi.waitFor(() => expect(exits.length).toBe(1));
    expect(exits[0]).toMatchObject({ code: 0, signal: null, expected: true });
    // 幂等：再 stop 不抛
    await expect(supervisor.stop()).resolves.toBeUndefined();
    // 停止后重新 start 可用
    const info = await supervisor.start({
      command: process.execPath,
      args: ["-e", KEEP_ALIVE_SCRIPT],
    });
    expect(info.port).toBe(3999);
    await supervisor.stop();
  }, 10_000);

  it("stop 超窗兜底：子进程无视 SIGTERM 时 SIGKILL 兜底", async () => {
    const supervisor = new ServerSupervisor({ stopTimeoutMs: 400 });
    await supervisor.start({
      command: process.execPath,
      args: [
        "-e",
        `
console.log('${HANDSHAKE_PREFIX}${JSON.stringify({
          port: 4002,
          token: "t",
          instanceId: "i",
        })}');
process.on('SIGTERM', () => {}); // 吞 SIGTERM
setInterval(() => {}, 1000);
`,
      ],
    });
    await supervisor.stop();
    expect(supervisor.state).toBe("stopped");
  }, 10_000);

  it("running 中重复 start 拒绝；stop 后可重启", async () => {
    const supervisor = new ServerSupervisor();
    await supervisor.start({
      command: process.execPath,
      args: ["-e", KEEP_ALIVE_SCRIPT],
    });
    await expect(
      supervisor.start({
        command: process.execPath,
        args: ["-e", KEEP_ALIVE_SCRIPT],
      }),
    ).rejects.toThrow(/运行中|已在/);
    await supervisor.stop();
    expect(supervisor.state).toBe("stopped");
  }, 10_000);
});

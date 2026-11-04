// 本地无头端 Supervisor（T15）：spawn tianshu-server 子进程并扫 stdout
// `TIANSHU_HANDSHAKE ` 前缀行解析连接信息（main.ts 握手契约，T3 实测）。
// spawn 路径以实测产物为准：tianshu-server 构建产物为 dist/src/main.js
// （T1/T8 ruling，非计划原文 dist/main.js）——路径由调用方（连接注册表
// localStart）拼装，本模块只管进程生命周期与握手。
// 状态机：stopped → starting →（握手行）running /（超时·非零退出·异常）error；
// stop() SIGTERM 优雅杀（超窗 SIGKILL 兜底）→ stopped。
import { spawn, type ChildProcess } from "node:child_process";
import Log from "../../commons/Log";

export type SupervisorState = "stopped" | "starting" | "running" | "error";

export interface SupervisorCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/** 握手行解析结果（main.ts：port/token/instanceId 同进程同值） */
export interface HandshakeInfo {
  port: number;
  token: string;
  instanceId: string;
}

export interface SupervisorExitInfo {
  code: number | null;
  signal: string | null;
  /** true=stop() 触发的预期退出；false=意外退出（崩溃/被杀） */
  expected: boolean;
}

export interface ServerSupervisorOptions {
  /** 握手超时窗（默认 10s；测试注入缩短） */
  handshakeTimeoutMs?: number;
  /** stop() 优雅退出等待窗，超窗 SIGKILL（默认 5s） */
  stopTimeoutMs?: number;
}

export const HANDSHAKE_PREFIX = "TIANSHU_HANDSHAKE ";
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;

export class ServerSupervisor {
  private _state: SupervisorState = "stopped";
  private child: ChildProcess | null = null;
  private expectedStop = false;
  private readonly handshakeTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly exitListeners = new Set<
    (info: SupervisorExitInfo) => void
  >();

  constructor(options: ServerSupervisorOptions = {}) {
    this.handshakeTimeoutMs =
      options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  }

  get state(): SupervisorState {
    return this._state;
  }

  /** 子进程退出通知（每订阅者一次退出事件）；返回退订函数 */
  onExit(fn: (info: SupervisorExitInfo) => void): () => void {
    this.exitListeners.add(fn);
    return () => {
      this.exitListeners.delete(fn);
    };
  }

  /** spawn 并等握手行；超时/非零退出/坏握手 JSON → kill + error */
  start(cmd: SupervisorCommand): Promise<HandshakeInfo> {
    if (this._state === "starting" || this._state === "running") {
      return Promise.reject(
        new Error(`supervisor 已在 ${this._state} 状态，拒绝重复 start`),
      );
    }
    this.expectedStop = false;
    this._state = "starting";
    return new Promise<HandshakeInfo>((resolve, reject) => {
      let settled = false;
      let stdoutBuffer = "";
      const child = spawn(cmd.command, cmd.args, {
        env: { ...process.env, ...(cmd.env ?? {}) },
        cwd: cmd.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.child = child;

      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(handshakeTimer);
        this.killChild();
        this._state = "error";
        reject(error);
      };
      const succeed = (info: HandshakeInfo): void => {
        if (settled) return;
        settled = true;
        clearTimeout(handshakeTimer);
        this._state = "running";
        Log.info(
          "无头端握手完成",
          `port=${info.port} instanceId=${info.instanceId}`,
        );
        resolve(info);
      };

      const handshakeTimer = setTimeout(() => {
        fail(
          new Error(
            `握手超时（${this.handshakeTimeoutMs}ms 无 ${HANDSHAKE_PREFIX.trim()} 行），已终止子进程`,
          ),
        );
      }, this.handshakeTimeoutMs);

      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        if (settled) return;
        stdoutBuffer += chunk;
        let boundary = stdoutBuffer.indexOf("\n");
        while (boundary !== -1) {
          const line = stdoutBuffer.slice(0, boundary);
          stdoutBuffer = stdoutBuffer.slice(boundary + 1);
          const info = parseHandshakeLine(line);
          if (info) {
            succeed(info);
            return;
          }
          boundary = stdoutBuffer.indexOf("\n");
        }
        // 无换行的单行握手（子进程只输出一行且不带 \n）：直接尝试整段解析
        const info = parseHandshakeLine(stdoutBuffer);
        if (info) {
          stdoutBuffer = "";
          succeed(info);
        }
      });
      // stderr 只记日志（Nest 启动日志走 stdout，错误栈走 stderr——不参与握手）
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        if (!settled && chunk.trim()) Log.warn("无头端 stderr:", chunk.trim());
      });
      child.once("error", (e) =>
        fail(new Error(`子进程启动失败: ${e.message}`)),
      );
      child.once("exit", (code, signal) => {
        const info: SupervisorExitInfo = {
          code,
          signal,
          expected: this.expectedStop,
        };
        this.child = null;
        if (!settled) {
          settled = true;
          clearTimeout(handshakeTimer);
          this._state = "error";
          reject(
            new Error(
              `子进程在握手前退出（退出码 ${code ?? "null"}，信号 ${signal ?? "null"}）`,
            ),
          );
        } else if (this.expectedStop) {
          this._state = "stopped";
        } else {
          // 运行中意外退出：非零退出码/信号 → error（brief：退出码非 0 → error）
          this._state = "error";
          Log.warn(
            "无头端意外退出",
            `退出码 ${code ?? "null"}，信号 ${signal ?? "null"}`,
          );
        }
        for (const fn of [...this.exitListeners]) {
          try {
            fn(info);
          } catch (e) {
            Log.warn("supervisor onExit 订阅者抛错（已隔离）", e);
          }
        }
      });
    });
  }

  /** 优雅停：SIGTERM → 等退出（超窗 SIGKILL 兜底）→ stopped */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.child = null;
      this._state = this._state === "starting" ? "stopped" : this._state;
      return;
    }
    this.expectedStop = true;
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        this.killChild();
        // SIGKILL 后 exit 事件兜底 resolve（防极端不达）
        hardResolveTimer = setTimeout(resolve, this.stopTimeoutMs);
      }, this.stopTimeoutMs);
      let hardResolveTimer: ReturnType<typeof setTimeout> | null = null;
      const finish = (): void => {
        clearTimeout(killTimer);
        if (hardResolveTimer) clearTimeout(hardResolveTimer);
        resolve();
      };
      child.once("exit", finish);
      this.killChild("SIGTERM");
    });
    this._state = "stopped";
  }

  /** 杀子进程（幂等；默认 SIGKILL 兜底路径） */
  private killChild(signal: NodeJS.Signals = "SIGKILL"): void {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill(signal);
    } catch {
      /* 已在退出流程 */
    }
  }
}

/** 握手行解析：`TIANSHU_HANDSHAKE {"port":..,"token":..,"instanceId":..}`；
 * 非前缀行/坏 JSON/字段缺失 → null（继续扫后续行） */
function parseHandshakeLine(line: string): HandshakeInfo | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(HANDSHAKE_PREFIX)) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(HANDSHAKE_PREFIX.length)) as {
      port?: unknown;
      token?: unknown;
      instanceId?: unknown;
    };
    if (
      typeof parsed.port === "number" &&
      typeof parsed.token === "string" &&
      typeof parsed.instanceId === "string"
    ) {
      return {
        port: parsed.port,
        token: parsed.token,
        instanceId: parsed.instanceId,
      };
    }
    return null;
  } catch {
    return null;
  }
}

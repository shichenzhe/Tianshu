/**
 * 终端会话管理（DetailPanel 终端 tab）：create/write/resize/kill 与
 * pty 数据/退出推送。零 electron import（node-pty 经工厂注入，vitest
 * 纯 Node 可测——node-pty 已被 install-app-deps 重编译为 Electron ABI，
 * 本模块不得直接 require）。
 */
import { randomUUID } from "node:crypto";

export interface PtyProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (code: number) => void): void;
}

export type PtyFactory = (
  file: string,
  args: string[],
  opts: { cwd: string; name: string },
) => PtyProcess;

export type TerminalSender = (channel: string, data: string) => void;

/** 每会话回放缓冲上限（UTF-16 码元，ASCII≈字节）；量级对齐 xterm 默认回滚 */
export const REPLAY_BUFFER_CAP = 128 * 1024;

interface TerminalEntry {
  pty: PtyProcess;
  sender: TerminalSender;
  /** 回放 chunk 队列（超 cap 丢最旧整 chunk，"约 cap" 语义） */
  chunks: string[];
  /** chunks 累计字符数（UTF-16 码元记账） */
  buffered: number;
}

export function defaultShell(
  platform: NodeJS.Platform = process.platform,
  shellEnv: string | undefined = process.env.SHELL,
): string {
  if (platform === "win32") return "powershell.exe";
  if (shellEnv && shellEnv.trim()) return shellEnv;
  return platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}

export class TerminalManager {
  private terminals = new Map<string, TerminalEntry>();

  constructor(
    private readonly ptyFactory: PtyFactory,
    private readonly fallbackSender: TerminalSender,
  ) {}

  create(sender: TerminalSender, cwd: string): string {
    const id = randomUUID();
    const pty = this.ptyFactory(defaultShell(), [], {
      cwd,
      name: "xterm-256color",
    });
    const entry: TerminalEntry = { pty, sender, chunks: [], buffered: 0 };
    this.terminals.set(id, entry);
    pty.onExit((code) => {
      if (this.terminals.get(id) === entry) this.terminals.delete(id);
      entry.sender(`terminal:exit:${id}`, String(code));
    });
    pty.onData((data) => {
      // 先入缓冲后推送：「已 send ⇒ 已入缓冲」是重挂回放去重的前提
      // （渲染端 replay 应答前收到的实时数据必已含于快照，见 TerminalTab）
      entry.chunks.push(data);
      entry.buffered += data.length;
      this.trim(entry);
      entry.sender(`terminal:data:${id}`, data);
    });
    return id;
  }

  /** 缓冲收缩：丢最旧整 chunk；仅剩单 chunk 且超限时截头保尾（cat 大文件） */
  private trim(entry: TerminalEntry): void {
    while (entry.buffered > REPLAY_BUFFER_CAP && entry.chunks.length > 1) {
      entry.buffered -= entry.chunks.shift()!.length;
    }
    if (entry.buffered > REPLAY_BUFFER_CAP) {
      const head = entry.chunks[0]!;
      entry.chunks[0] = head.slice(head.length - REPLAY_BUFFER_CAP);
      entry.buffered = REPLAY_BUFFER_CAP;
    }
  }

  write(id: string, data: string): void {
    this.terminals.get(id)?.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    this.terminals.get(id)?.pty.resize(cols, rows);
  }

  kill(id: string): void {
    const entry = this.terminals.get(id);
    if (!entry) return;
    this.terminals.delete(id);
    entry.pty.kill();
  }

  killAll(): void {
    for (const id of [...this.terminals.keys()]) this.kill(id);
  }

  count(): number {
    return this.terminals.size;
  }

  /** 会话是否仍存活（pty 退出/kill 均移除登记；挂起重挂探活依据） */
  has(id: string): boolean {
    return this.terminals.has(id);
  }

  /**
   * 重放缓冲（重挂续连）：返回 cap 内累计输出，头部对齐首个换行防 ANSI
   * 序列被 cap 腰斩（对齐最多丢首个完整行；无换行单行巨串原样返回）。
   * id 不存在抛错（渲染端转退出态，语义对齐 probe=false）；空缓冲返回
   * "" 是合法值（会话存活但尚无输出）
   */
  replay(id: string): string {
    const entry = this.terminals.get(id);
    if (!entry) throw new Error(`terminal not found: ${id}`);
    const text = entry.chunks.join("");
    const nl = text.indexOf("\n");
    return nl === -1 ? text : text.slice(nl + 1);
  }
}

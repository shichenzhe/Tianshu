/**
 * 终端 IPC 封装：create 走 invoke（鉴权 + 拿 id）；write/resize/kill 高频
 * 走 send。数据/退出经 terminal:data:<id> / terminal:exit:<id> 事件订阅
 * （TerminalTab 内 on()）。
 */
import { invoke, send } from "@/lib/ipc";

export class TerminalApi {
  static create(cwd: string): Promise<string> {
    return invoke<string>("terminal:create", cwd);
  }

  /** 挂起重挂探活：pty 是否仍存活（false = 已退出，应显示退出态） */
  static probe(id: string): Promise<boolean> {
    return invoke<boolean>("terminal:probe", id);
  }

  /** 重挂回放：拉取 cap 内累计输出（id 不存在 reject → 调用方转退出态） */
  static replay(id: string): Promise<string> {
    return invoke<string>("terminal:replay", id);
  }

  static write(id: string, data: string): void {
    send("terminal:write", id, data);
  }

  static resize(id: string, cols: number, rows: number): void {
    send("terminal:resize", id, cols, rows);
  }

  static kill(id: string): void {
    send("terminal:kill", id);
  }
}

export default TerminalApi;

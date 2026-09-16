/**
 * 命令判定门模块单例（SP2 spec §4.1）：registry 同款模块级单例模式，
 * Application 装配时 install（闭包读 SecurityService 内存缓存）；
 * chat.service 与 automation-runner 两处装配直接 import commandGate。
 * fail-open：未安装/异常一律 "default"（回到既有审批链，不阻断执行）。
 */
import type { SecurityConfig } from "../../../src-react/domains/security/model/types";
import { decideCommand, type CommandDecision } from "./command-policy";

export type { CommandDecision };

/** 由配置读函数构造判定器：总开关旁路 + 规则判定 + 异常 fail-open */
export function makeCommandDecider(
  getConfigValue: () => SecurityConfig,
): (command: string) => CommandDecision {
  return (command) => {
    try {
      const config = getConfigValue();
      if (!config.sandboxEnabled) return "default";
      return decideCommand(command, {
        programBlacklist: config.programBlacklist,
        cmdAsk: config.cmdAsk,
        cmdAllow: config.cmdAllow,
      });
    } catch {
      return "default";
    }
  };
}

let installed: ((command: string) => CommandDecision) | null = null;

export function installCommandGate(
  fn: (command: string) => CommandDecision,
): void {
  installed = fn;
}

export function commandGate(command: string): CommandDecision {
  try {
    return installed?.(command) ?? "default";
  } catch {
    return "default";
  }
}

/** 子进程程序黑名单单例（SP2 spec §5.1）：Application install 配置读函数，
 * chat.service executeToolSafe 装配时消费；fail-open：未安装/异常返回 [] */
let watchlistGetter: (() => string[]) | null = null;

export function installCommandWatchlist(fn: () => string[]): void {
  watchlistGetter = fn;
}

export function commandWatchBlacklist(): string[] {
  try {
    return watchlistGetter?.() ?? [];
  } catch {
    return [];
  }
}

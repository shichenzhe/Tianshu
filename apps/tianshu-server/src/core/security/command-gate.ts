/**
 * 命令判定门模块单例（自 mirror electron/domains/security/command-gate.ts
 * 移植）：服务端装配时 install（闭包读安全配置）；未安装/异常一律
 * "default"（fail-open，回到既有审批链，不阻断执行）。allowDangerousTools
 * 的整体禁用（run_command 全拒）在 tool-gate 收口，不经本门。
 */
import {
  decideCommand,
  type CommandDecision,
  type CmdRule,
} from './command-policy';

export type { CommandDecision };

/** 判定输入（mirror SecurityConfig 的命令安全子集） */
export interface CommandGateConfig {
  sandboxEnabled: boolean;
  programBlacklist: string[];
  cmdAsk: CmdRule[];
  cmdAllow: CmdRule[];
}

/** 由配置读函数构造判定器：总开关旁路 + 规则判定 + 异常 fail-open */
export function makeCommandDecider(
  getConfigValue: () => CommandGateConfig,
): (command: string) => CommandDecision {
  return (command) => {
    try {
      const config = getConfigValue();
      if (!config.sandboxEnabled) return 'default';
      return decideCommand(command, {
        programBlacklist: config.programBlacklist,
        cmdAsk: config.cmdAsk,
        cmdAllow: config.cmdAllow,
      });
    } catch {
      return 'default';
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
    return installed?.(command) ?? 'default';
  } catch {
    return 'default';
  }
}

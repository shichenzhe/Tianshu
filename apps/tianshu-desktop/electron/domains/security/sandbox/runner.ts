/**
 * OS 级沙箱 runner（OS 沙箱 spec §3）：接口 + 平台分发 + 模块单例，
 * 结构对齐 command-gate.ts（Application 装配时 install，闭包读
 * SecurityService 内存缓存）。三条件合成（osSandboxEnabled × 平台可用 ×
 * 非 full）逐命令在 wrap 内求值——配置热切换即时生效；未安装/异常
 * fail-open 透传，回落现有审批链不阻断执行（裁定假设 #3）。
 * 平台矩阵（spec §9）：darwin → Seatbelt；win32/Linux → 诚实 no-op。
 */
import type { SecurityConfig } from "../../../../src-react/domains/security/model/types";
import { SeatbeltRunner, seatbeltAvailable } from "./seatbelt";

export interface SandboxWrapOptions {
  workspacePath: string;
  fullAccess: boolean;
}

export interface SandboxWrapResult {
  /** 包装后的完整命令行（透传时 === 原命令） */
  command: string;
  /** 是否实际进入沙箱（审计与测试判定；透传恒 false） */
  sandboxed: boolean;
}

export interface SandboxRunner {
  /** 平台可用性：darwin 且 sandbox-exec 存在 */
  available(): boolean;
  /** 包装：不可用/未启用/full 档返回原命令（fail-open） */
  wrap(command: string, opts: SandboxWrapOptions): SandboxWrapResult;
}

const NoopRunner: SandboxRunner = {
  available: () => false,
  wrap: (command) => ({ command, sandboxed: false }),
};

function platformRunner(): SandboxRunner {
  return process.platform === "darwin" ? SeatbeltRunner : NoopRunner;
}

let configGetter: (() => SecurityConfig) | null = null;

/** Application 装配 install（闭包读 SecurityService 内存缓存） */
export function installSandboxRunner(
  getConfigValue: () => SecurityConfig,
): void {
  configGetter = getConfigValue;
}

/** 测试隔离用卸载（生产不消费） */
export function resetSandboxRunnerForTest(): void {
  configGetter = null;
}

/** 未安装 fail-open 透传（vitest/装配前零行为） */
function passthrough(command: string): SandboxWrapResult {
  return { command, sandboxed: false };
}

/** 沙箱 runner 单例（command-gate 同款）：enabled 判定不入平台 runner */
export function getSandboxRunner(): SandboxRunner {
  const runner = platformRunner();
  return {
    available: () => runner.available(),
    wrap: (command, opts) => {
      try {
        if (!configGetter?.().osSandboxEnabled) return passthrough(command);
      } catch {
        return passthrough(command);
      }
      return runner.wrap(command, opts);
    },
  };
}

/** 安全中心开关卡状态透出（spec §6.2/§11.4）：平台支持 × 组件可用 */
export function osSandboxStatus(): { supported: boolean; available: boolean } {
  const supported = process.platform === "darwin";
  return { supported, available: supported && seatbeltAvailable() };
}

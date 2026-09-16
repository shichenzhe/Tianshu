/**
 * 文件判定门模块单例（SP3 spec §4.1，command-gate 同款模式）：
 * Application 装配时 install（闭包读 SecurityService 缓存 + extraBuiltin
 * 运行时内置清单——userData 自我保护）；fail-open 三层 → "default"。
 */
import type { SecurityConfig } from "../../../src-react/domains/security/model/types";
import { defaultFileBlocklist } from "./defaults";
import { decideFileAccess, type FileAccessDecision } from "./file-policy";

export function makeFileDecider(
  getConfigValue: () => SecurityConfig,
  extraBuiltin: string[],
): (absPath: string, workspacePath: string) => FileAccessDecision {
  return (absPath, workspacePath) => {
    try {
      const config = getConfigValue();
      if (!config.sandboxEnabled) return "default";
      return decideFileAccess(absPath, workspacePath, {
        builtinBlocklist: [
          ...defaultFileBlocklist(process.platform),
          ...extraBuiltin,
        ],
        fileBlocklist: config.fileBlocklist,
        fileAllowlist: config.fileAllowlist,
      });
    } catch {
      return "default";
    }
  };
}

let installed:
  ((absPath: string, workspacePath: string) => FileAccessDecision) | null =
  null;

export function installFileGate(
  fn: (absPath: string, workspacePath: string) => FileAccessDecision,
): void {
  installed = fn;
}

export function fileGate(
  absPath: string,
  workspacePath: string,
): FileAccessDecision {
  try {
    return installed?.(absPath, workspacePath) ?? "default";
  } catch {
    return "default";
  }
}

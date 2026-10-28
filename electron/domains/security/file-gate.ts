/**
 * 文件判定门模块单例（SP3 spec §4.1，command-gate 同款模式）：
 * Application 装配时 install（闭包读 SecurityService 缓存 + extraBuiltin
 * 运行时内置清单——userData 自我保护）；fail-open 三层 → "default"。
 * grantedOf（文件窗口 spec §6.4）：会话级授权清单同步判定——命中优先于
 * extraBuiltin（数据根）拦截返回 "default"（read 放行；write 审批仍由
 * write_file kind:"write" 的审批横幅走，授权不绕过）。
 */
import type { SecurityConfig } from "../../../src-react/domains/security/model/types";
import { defaultFileBlocklist } from "./defaults";
import { decideFileAccess, type FileAccessDecision } from "./file-policy";

export function makeFileDecider(
  getConfigValue: () => SecurityConfig,
  extraBuiltin: string[],
  grantedOf?: (absPath: string) => boolean,
): (absPath: string, workspacePath: string) => FileAccessDecision {
  return (absPath, workspacePath) => {
    try {
      // 会话授权清单（spec §6.4）：授权路径不因 extraBuiltin（数据根）拦截
      // ——其余路径（数据根内未授权与全部内置敏感清单）保护不变
      if (grantedOf?.(absPath)) return "default";
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

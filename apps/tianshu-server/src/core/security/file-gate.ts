/**
 * 文件判定门模块单例（自 mirror electron/domains/security/file-gate.ts
 * 移植，command-gate 同款模式）：服务端装配时 install（闭包读安全配置 +
 * extraBuiltin 运行时内置清单——数据根自我保护）；未安装/异常 fail-open
 * "default"。mirror 的 grantedOf（文件窗口会话级授权覆盖）特性未随本批
 * 移植——服务端无文件窗口，grantedPaths 清单缺席时语义不变。
 */
import { defaultFileBlocklist } from './file-blocklist';
import { decideFileAccess, type FileAccessDecision } from './file-policy';

/** 判定输入（mirror SecurityConfig 的文件安全子集） */
export interface FileGateConfig {
  sandboxEnabled: boolean;
  fileBlocklist: string[];
  fileAllowlist: string[];
}

export function makeFileDecider(
  getConfigValue: () => FileGateConfig,
  extraBuiltin: string[],
): (absPath: string, workspacePath: string) => FileAccessDecision {
  return (absPath, workspacePath) => {
    try {
      const config = getConfigValue();
      if (!config.sandboxEnabled) return 'default';
      return decideFileAccess(absPath, workspacePath, {
        builtinBlocklist: [
          ...defaultFileBlocklist(process.platform),
          ...extraBuiltin,
        ],
        fileBlocklist: config.fileBlocklist,
        fileAllowlist: config.fileAllowlist,
      });
    } catch {
      return 'default';
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
    return installed?.(absPath, workspacePath) ?? 'default';
  } catch {
    return 'default';
  }
}

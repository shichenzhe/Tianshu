/**
 * 安全配置默认值 + 内置敏感路径清单（SP1 spec §5.1/§5.2）。
 * 内置清单永不落盘（WorkBuddy 同构三层防删的第一层），
 * 展示合并与保存剔除见 config-store.ts 的 mergeRuleList/stripBuiltinItems。
 */
import type { SecurityConfig } from "../../../src-react/domains/security/model/types";

/** 14 项安全配置默认值（read-time fallback 的唯一事实源） */
export const SECURITY_DEFAULTS: SecurityConfig = {
  sandboxEnabled: true,
  fileAllowlist: [],
  fileBlocklist: [],
  cmdAllow: [{ prefix: ["git", "push"] }, { prefix: ["npm", "install"] }],
  cmdAsk: [{ prefix: ["curl"] }, { prefix: ["wget"] }],
  programBlacklist: ["rm"],
  domainAllow: [],
  domainDeny: [],
  blockAllNetwork: false,
  maliciousDomainProtection: true,
  fileBackupEnabled: true,
  fileBackupMaxSizeMB: 3000,
  deleteProtection: true,
  bulkDeleteThreshold: 50,
};

/** 内置文件黑名单全量清单（照 WorkBuddy 默认文件安全规则，PRD 同源） */
export const BUILTIN_FILE_BLOCKLIST_ALL = [
  "~/.ssh/",
  "~/.aws/",
  "~/.gnupg/",
  "~/.gpg/",
  "~/.kube/config",
  "~/.docker/config.json",
  "~/.docker/daemon.json",
  "~/.netrc",
  "~/.npmrc",
  "~/.pypirc",
  "~/.gem/credentials",
  "~/.config/gh/hosts.yml",
  "~/.git-credentials",
  "~/.config/gcloud/",
  "~/.azure/",
  "~/.terraform.d/credentials.tfrc.json",
  "~/Library/Keychains/",
];

/** 按平台过滤内置清单（Windows 剔除 macOS 钥匙串） */
export function defaultFileBlocklist(platform: NodeJS.Platform): string[] {
  if (platform === "win32") {
    return BUILTIN_FILE_BLOCKLIST_ALL.filter(
      (p) => p !== "~/Library/Keychains/",
    );
  }
  return [...BUILTIN_FILE_BLOCKLIST_ALL];
}

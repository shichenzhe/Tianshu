/**
 * 内置敏感路径清单（自 mirror electron/domains/security/defaults.ts 的
 * defaultFileBlocklist/BUILTIN_FILE_BLOCKLIST_ALL 摘取；恶意域清单与
 * SECURITY_DEFAULTS 其余项未随本批移植——服务端安全中心接线时再补）。
 * 内置清单永不落盘（三层防删的第一层），随版本更新。
 */

/** 内置文件黑名单全量清单（照 WorkBuddy 默认文件安全规则） */
export const BUILTIN_FILE_BLOCKLIST_ALL = [
  '~/.ssh/',
  '~/.aws/',
  '~/.gnupg/',
  '~/.gpg/',
  '~/.kube/config',
  '~/.docker/config.json',
  '~/.docker/daemon.json',
  '~/.netrc',
  '~/.npmrc',
  '~/.pypirc',
  '~/.gem/credentials',
  '~/.config/gh/hosts.yml',
  '~/.git-credentials',
  '~/.config/gcloud/',
  '~/.azure/',
  '~/.terraform.d/credentials.tfrc.json',
  '~/Library/Keychains/',
];

/** 按平台过滤内置清单（Windows 剔除 macOS 钥匙串） */
export function defaultFileBlocklist(platform: NodeJS.Platform): string[] {
  if (platform === 'win32') {
    return BUILTIN_FILE_BLOCKLIST_ALL.filter(
      (p) => p !== '~/Library/Keychains/',
    );
  }
  return [...BUILTIN_FILE_BLOCKLIST_ALL];
}

/**
 * 命令安全判定引擎（自 mirror electron/domains/security/command-policy.ts
 * 逐字移植，纯函数）：优先级 程序黑名单 > 询问名单 > 放行名单 > default
 * （WorkBuddy 同构，"ask wins over allow"）。token 化为简化 shell 词法。
 */
export type CommandDecision = 'block' | 'ask' | 'allow' | 'default';

/** 命令名单规则（mirror security model 的 CmdRule 同构） */
export interface CmdRule {
  prefix: string[];
}

export interface CommandRules {
  programBlacklist: string[];
  cmdAsk: CmdRule[];
  cmdAllow: CmdRule[];
}

/** 简化 shell 词法：按空白分割、剥离首尾成对引号、剔除空 token */
export function tokenizeCommand(command: string): string[] {
  return command
    .split(/\s+/)
    .map((raw) => raw.replace(/^["']+|["']+$/g, ''))
    .filter((token) => token !== '');
}

/** 路径基名：posix/win32 分隔符统一后取末段（"/usr/bin/rm" → "rm"） */
export function programBasename(token: string): string {
  const segments = token.replace(/\\/g, '/').split('/');
  return segments[segments.length - 1] ?? token;
}

/** prefix 前缀匹配：tokens 前 N 项与 rule.prefix 逐 token 相等 */
function matchesPrefix(tokens: string[], rules: CmdRule[]): boolean {
  return rules.some(
    (rule) =>
      rule.prefix.length > 0 &&
      rule.prefix.length <= tokens.length &&
      rule.prefix.every((token, i) => tokens[i] === token),
  );
}

export function decideCommand(
  command: string,
  rules: CommandRules,
): CommandDecision {
  const tokens = tokenizeCommand(command);
  if (tokens.length === 0) return 'default';
  if (rules.programBlacklist.includes(programBasename(tokens[0]))) {
    return 'block';
  }
  if (matchesPrefix(tokens, rules.cmdAsk)) return 'ask';
  if (matchesPrefix(tokens, rules.cmdAllow)) return 'allow';
  return 'default';
}

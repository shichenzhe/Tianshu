/**
 * 命令安全判定引擎（SP2 spec §3，纯函数；自 mirror 逐字移植——安全批
 * S4 双份同步）：
 * 优先级 程序黑名单 > 询问名单 > 放行名单 > default（WorkBuddy 同构，
 * "ask wins over allow"）。token 化为简化 shell 词法（空白分割 +
 * 成对引号剥离），不引入完整 shell 解析器——命令替换混淆由
 * 审批层与子进程监控兜底。
 * 安全批 S4（2026-11-02 审查）：黑名单判定从仅首 token 扩展为
 * 「命令位序列」——包装器（bash -c/env/nohup/…）后的命令位同样比对，
 * 堵 `bash -c 'rm …'`/`env rm …` 类首 token 伪装绕过。
 */
/** 命令名单规则（mirror security model 的 CmdRule 同构——server 树无
 * src-react 路径，本地定义） */
export interface CmdRule {
  prefix: string[];
}

export type CommandDecision = "block" | "ask" | "allow" | "default";

export interface CommandRules {
  programBlacklist: string[];
  cmdAsk: CmdRule[];
  cmdAllow: CmdRule[];
}

/**
 * 透传包装器：其后第一个非选项 token 视为实际命令（`env rm x` 的 rm、
 * `bash -c 'rm x'` 词法化后的 rm）；sudo/setsid/stdbuf 同理。选项
 * （-x/--long）与包装器自身的参数值（如 env 的 VAR=1）跳过。
 */
const WRAPPERS = new Set([
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "env",
  "nohup",
  "time",
  "xargs",
  "setsid",
  "stdbuf",
  "exec",
  "sudo",
  "nice",
  "command",
]);

/** 简化 shell 词法：按空白分割、剥离首尾成对引号、剔除空 token */
export function tokenizeCommand(command: string): string[] {
  return command
    .split(/\s+/)
    .map((raw) => raw.replace(/^["']+|["']+$/g, ""))
    .filter((token) => token !== "");
}

/** 路径基名：posix/win32 分隔符统一后取末段（"/usr/bin/rm" → "rm"） */
export function programBasename(token: string): string {
  const segments = token.replace(/\\/g, "/").split("/");
  return segments[segments.length - 1] ?? token;
}

/**
 * 命令位序列：tokens 中会被当作「程序名」执行的位置——首 token 起，
 * 跳过包装器/选项/环境赋值（VAR=x），收集每个非包装器 token 的候选
 * 命令位（截前 6 个防长命令尾部参数误伤）。`bash -c 'rm -rf /'` 词法
 * 化为 [bash, -c, rm, -rf, /] → 命令位 [bash, rm]。
 */
export function commandPositions(tokens: string[]): string[] {
  const positions: string[] = [];
  for (const token of tokens.slice(0, 8)) {
    if (token.startsWith("-")) continue; // 选项
    const base = programBasename(token);
    if (positions.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      continue; // env 的 VAR=value 赋值
    }
    positions.push(base);
    if (!WRAPPERS.has(base)) break; // 非包装器即为终点命令
  }
  return positions;
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
  if (tokens.length === 0) return "default";
  // 安全批 S4：黑名单比对全部命令位（包装器透传后的真身同样拦）
  const blacklist = new Set(rules.programBlacklist);
  if (commandPositions(tokens).some((base) => blacklist.has(base))) {
    return "block";
  }
  if (matchesPrefix(tokens, rules.cmdAsk)) return "ask";
  if (matchesPrefix(tokens, rules.cmdAllow)) return "allow";
  return "default";
}

/**
 * 危险命令分级表（权限放宽 spec §4.1，2026-10-24；自 mirror
 * electron/domains/security/command-risk.ts 逐字移植，双引号→单引号）：
 * 内置静态正则永不落盘（照 BUILTIN_FILE_BLOCKLIST_ALL 三层防删模式，用户
 * 不可关；可经 cmdAsk 加严）。CRITICAL 先于 HIGH。正则精选自 WorkBuddy
 * CommandUtils.checkSingleCommandSafety O/M 表（2026-10-24 逆向）。
 * 分段为粗分（;/&&/||/|/换行），不做完整 shell 解析——引号内分隔符误分由
 * 子进程监控与审批兜底（spec §6 已知边界）。
 * 大小写不敏感（攻击面 RM -RF/Sudo 穿透，终审 Critical 2026-10-24）：
 * 段统一小写归一后匹配，表内字面量保持全小写（带 /i 的条目不受影响）。
 */

export type CommandRisk = 'critical' | 'high' | null;

/** 极高危：不可逆破坏（磁盘/系统/主干/数据全灭）——default 与 full 均强制审批 */
const CRITICAL_PATTERNS: RegExp[] = [
  /rm\s+(-[rf]+|--recursive|--force).*\/(\s|$)/, // rm -rf /（根）
  /rm\s+(-[rf]+|--recursive|--force).*(\/(etc|usr|var|sys|boot|lib)|~\/\*)/,
  /\bdd\b.*of=\/(dev|sys|boot)/,
  /\bmkfs\b/,
  /\bfdisk\b/,
  /\bparted\b/,
  />\s*\/(etc|boot|sys)\//,
  /crontab\s+-r/,
  /\buserdel\b/,
  /\bgroupdel\b/,
  /DROP\s+DATABASE/i,
  /\bTRUNCATE\s+TABLE\b/i,
  /DELETE\s+FROM.*WHERE\s+(1=1|true)/i,
  /FLUSHALL/i,
  /FLUSHDB/i,
  /terraform\s+destroy/,
  /aws\s+\S+\s+delete\b/,
  /az\s+\S+\s+delete\b/,
  /gcloud\s+\S+\s+delete\b/,
  /git\s+reset\s+--hard/,
  /git\s+clean\s+-[fdxX]/,
  /git\s+checkout\s+-[fF]\b/,
  /git\s+stash\s+clear/,
  /git\s+checkout\s+--\s+\./, // 整仓回滚（单文件在 HIGH）
  /git\s+push(\s+[^\s]+)*\s+(-f|--force)(\s|$).*\b(main|master|develop|release|production)\b/,
  /git\s+push(\s+[^\s]+)*\s+\b(main|master|develop|release|production)\b(\s+[^\s]+)*\s+(-f|--force)(\s|$)/,
  /git\s+push(\s+[^\s]+)*\s+(--delete)(\s|$).*\b(main|master|develop|release|production)\b/,
  /git\s+push\s+[^\s]+\s+:(main|master|develop|release|production)\b/,
  /git\s+branch\s+-[dD]\s+(main|master|develop|release|production)\b/,
];

/** 高危：高破坏面但可恢复/可审（提权/递归删/强推）——default 审批，full 亦审批（对齐 WorkBuddy bypass） */
const HIGH_PATTERNS: RegExp[] = [
  /\bsudo\b/, // 去行首锚定（env sudo/换行续段穿透，终审 Important 2026-10-24）；echo 参数误报为粗分边界，偏安全侧
  /\bsu\s/, // 同上去锚定（独立词元 su 后跟空白）；误报同上偏安全侧
  /\bchmod\s+777\b/,
  /\brm\s+(-[^\s]*r|-[^\s]*R|--recursive)/, // 无尾 \b：-rf 的 r 后跟 f 不成边界，带 \b 永不命中
  /\bshred\b/,
  /\bwipe\b/,
  /\btruncate\b.*-s\s*0/,
  /git\s+branch\s+-d\b/, // 输入已小写归一（原 -D；-d 安全删同升 HIGH，偏安全侧）
  /git\s+push(\s+[^\s]+)*\s+(-f|--force)(\s|$)/,
  /git\s+push(\s+[^\s]+)*\s+(--delete)(\s|$)/,
  /git\s+push\s+[^\s]+\s+:/,
  /git\s+filter-branch/,
  /git\s+filter-repo/,
  /git\s+worktree\s+(remove|prune)/,
  /git\s+reflog\s+(delete|expire)/,
  /git\s+checkout\s+--\s+\S/,
  /git\s+restore\b/,
  /git\s+stash\s+drop/,
  /kubectl\s+(delete|drain)\b/,
  /docker\s+(system\s+prune|volume\s+rm)\b/,
  /find\s+.*(-delete|-exec\s+rm)/,
  /\bxargs\s+rm\b/, // 段内匹配（分段后管道前缀不在段内；echo "xargs rm" 误报为粗分边界，偏安全侧）
  /\brm\s+(?:-[^\s]*\s+)*\S*[*?]/, // rm 带通配符
];

/** 粗分段：shell 组合/管道/换行分隔符切分（不做引号感知——精度边界见头注释） */
function splitSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\||\n|\r/)
    .map((seg) => seg.trim())
    .filter((seg) => seg !== '');
}

export function assessCommandRisk(command: string): CommandRisk {
  for (const rawSegment of splitSegments(command)) {
    // 大小写归一（RM -RF/Sudo 穿透，终审 Critical 2026-10-24）
    const segment = rawSegment.toLowerCase();
    for (const pattern of CRITICAL_PATTERNS) {
      if (pattern.test(segment)) return 'critical';
    }
  }
  for (const rawSegment of splitSegments(command)) {
    const segment = rawSegment.toLowerCase();
    for (const pattern of HIGH_PATTERNS) {
      if (pattern.test(segment)) return 'high';
    }
  }
  return null;
}

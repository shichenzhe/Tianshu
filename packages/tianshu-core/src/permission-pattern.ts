/** 参数级审批 pattern 匹配（skills-tools-mcp §6-6 / security P1-3）：
 *  toolPermission 行可选 pattern 列的命中判定单源——bash 命令前缀（token
 *  级，复用 cmdAllow prefix 规则数据结构）与 write/rm 路径 glob（段级，
 *  `*` 不跨分隔符、`**` 跨段）。
 *  安全红线：pattern 匹配是**放宽**记忆面——命中判定必须保守。bash 前缀
 *  不越过 shell 元字符（管道/顺序/条件链、重定向、命令替换、子 shell 一律
 *  不命中，`git *` 不得覆盖 `git push; rm -rf /`）；路径 glob 不匹配相对
 *  逃逸段与绝对路径。cmdAllow 的 matchesPrefix 本身无元字符守卫（其上下
 *  文中 allow 仅跳过询问，程序黑名单/危险分级硬线仍独立把关），本处因
 *  toolPermission 是**持久**放宽面，在其 token 前缀结构上加守卫收紧。
 *  保守缺省：无 pattern 行 = 旧全等语义（任意参数命中，见
 *  isRememberedPermission），本函数只判定 pattern 行。 */
/** bash pattern 的 shell 元字符守卫：命令含任一即不命中（防前缀记忆
 *  扩大到链式新命令/重定向/命令替换——防 `git *; rm -rf` 被 `git *`
 *  覆盖的安全关键） */
const BASH_FORBIDDEN_METACHARS = /[|;&<>\n`$(){}]/;

/** 参数级 pattern 语义支持的路径类工具（args.path 为匹配标的） */
const PATH_PATTERN_TOOLS: ReadonlySet<string> = new Set(["write", "rm"]);

/** 简化 shell 词法（与 security/command-policy tokenizeCommand 同构）：
 *  按空白分割、剥离首尾成对引号、剔除空 token */
function tokenizeCommandValue(value: string): string[] {
  return value
    .split(/\s+/)
    .map((raw) => raw.replace(/^["']+|["']+$/g, ""))
    .filter((token) => token !== "");
}

function commandOf(args?: unknown): string | null {
  const command = (args as { command?: unknown } | null)?.command;
  return typeof command === "string" && command.trim() !== ""
    ? command
    : null;
}

/** bash 命令前缀 pattern：`git *` / `git push *` / 精确 `git status`。
 *  通配只允许尾 token；命中前先过元字符守卫 */
function matchBashPattern(pattern: string, args?: unknown): boolean {
  const command = commandOf(args);
  if (command === null) return false;
  if (BASH_FORBIDDEN_METACHARS.test(command)) return false;
  const patternTokens = tokenizeCommandValue(pattern);
  if (patternTokens.length === 0) return false;
  const commandTokens = tokenizeCommandValue(command);
  if (commandTokens.length === 0) return false;
  const wildcard = patternTokens[patternTokens.length - 1] === "*";
  const prefix = wildcard ? patternTokens.slice(0, -1) : patternTokens;
  if (prefix.length === 0) {
    // 整体通配（手写 `*`）：显式全量声明，按工具级语义放行
    return true;
  }
  if (prefix.some((token) => token === "*")) return false; // 仅尾 token 通配
  if (prefix.length > commandTokens.length) return false;
  return (
    prefix.every((token, i) => commandTokens[i] === token) &&
    (wildcard || prefix.length === commandTokens.length)
  );
}

/** 路径归一：反斜杠统一、去首 `./` 与首尾空白；绝对路径（posix/win 盘符）
 *  返回 null（记忆声明仅对工作空间相对路径生效——绝对路径交文件门裁定） */
function normalizeRelativePath(value: string): string[] | null {
  const unified = value.trim().replace(/\\/g, "/");
  if (unified.startsWith("/") || /^[A-Za-z]:\//.test(unified)) return null;
  const segments = unified
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .map(decodeURIComponentSafe);
  if (segments.some((segment) => segment === "..")) return null;
  return segments;
}

/** decodeURIComponent 容错：非法百分号序列原样保留（不因编码抛错漏判） */
function decodeURIComponentSafe(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** 段内 glob（`*` 任意串 / `?` 单字符，经典回溯）；段已按 `/` 拆分，
 *  天然不跨分隔符 */
function globMatchSegment(pattern: string, value: string): boolean {
  let pi = 0;
  let si = 0;
  let star = -1;
  let mark = -1;
  while (si < value.length) {
    if (pi < pattern.length && (pattern[pi] === "?" || pattern[pi] === value[si])) {
      pi += 1;
      si += 1;
    } else if (pi < pattern.length && pattern[pi] === "*") {
      star = pi;
      pi += 1;
      mark = si;
    } else if (star !== -1) {
      pi = star + 1;
      si = ++mark;
    } else {
      return false;
    }
  }
  while (pi < pattern.length && pattern[pi] === "*") pi += 1;
  return pi === pattern.length;
}

/** 段级匹配：`**` 独立段匹配零或多段，普通段按段内 glob 全匹配 */
function matchSegments(pattern: string[], target: string[]): boolean {
  if (pattern.length === 0) return target.length === 0;
  const [head, ...rest] = pattern;
  if (head === "**") {
    for (let skip = 0; skip <= target.length; skip += 1) {
      if (matchSegments(rest, target.slice(skip))) return true;
    }
    return false;
  }
  if (target.length === 0) return false;
  return (
    globMatchSegment(head, target[0]) &&
    matchSegments(pattern.slice(1), target.slice(1))
  );
}

/** write/rm 路径 glob pattern：`src/**` / `*.ts` / 精确 `a.txt` */
function matchPathPattern(pattern: string, args?: unknown): boolean {
  const rel = (args as { path?: unknown } | null)?.path;
  if (typeof rel !== "string" || rel.trim() === "") return false;
  const target = normalizeRelativePath(rel);
  const patternSegments = normalizeRelativePath(pattern);
  if (target === null || patternSegments === null) return false;
  return matchSegments(patternSegments, target);
}

/**
 * toolPermission pattern 行命中判定（三端单源）：
 * - bash：命令 token 前缀（`git *`），元字符守卫前置；
 * - write/rm：路径段级 glob（`src/**`，`*` 不跨分隔符）；
 * - 其余工具保守不命中（无参数级语义，整工具记忆走无 pattern 行）。
 */
export function matchPermissionPattern(
  pattern: string,
  toolName: string,
  args?: unknown,
): boolean {
  const trimmed = pattern.trim();
  if (trimmed === "") return false;
  if (toolName === "bash") return matchBashPattern(trimmed, args);
  if (PATH_PATTERN_TOOLS.has(toolName)) return matchPathPattern(trimmed, args);
  return false;
}

/**
 * 审批横幅「始终允许」前缀建议（与匹配语义同源）：
 * - bash：命令首 token + ` *`（含元字符的命令不提供——防误扩）；
 * - write/rm：所在目录 + `/**`（根级文件无目录前缀，返回 null）；
 * - 其余工具 null（横幅只出「整个工具」单项）。
 */
export function suggestRememberPattern(
  toolName: string,
  args?: unknown,
): string | null {
  if (toolName === "bash") {
    const command = commandOf(args);
    if (command === null || BASH_FORBIDDEN_METACHARS.test(command)) {
      return null;
    }
    const tokens = tokenizeCommandValue(command);
    return tokens.length > 0 ? `${tokens[0]} *` : null;
  }
  if (PATH_PATTERN_TOOLS.has(toolName)) {
    const rel = (args as { path?: unknown } | null)?.path;
    if (typeof rel !== "string" || rel.trim() === "") return null;
    const segments = normalizeRelativePath(rel);
    if (segments === null || segments.length <= 1) return null;
    return `${segments.slice(0, -1).join("/")}/**`;
  }
  return null;
}

/** toolPermission 行最小结构（prisma 行投影） */
export interface RememberedPermissionRow {
  id: number;
  pattern?: string | null;
}

/** isRememberedPermission 的 prisma 结构最小面（findMany 投影 + update 回写） */
export interface ToolPermissionDbLike {
  toolPermission: {
    findMany(args: {
      where: { workspaceId: number; toolName: string };
      select: { id: true; pattern: true };
    }): Promise<RememberedPermissionRow[]>;
    update(args: {
      where: { id: number };
      data: { lastUsedAt: Date };
    }): Promise<unknown>;
  };
}

/** 命中行 lastUsedAt 回写（fire-and-forget：失败吞错不影响判定主流程） */
function touchLastUsedAt(
  db: ToolPermissionDbLike,
  id: number,
): void {
  void db.toolPermission
    .update({ where: { id }, data: { lastUsedAt: new Date() } })
    .catch(() => {
      // 埋点性质回写（记忆治理 §6-5）：失败静默——下次命中再补
    });
}

/**
 * 工作空间记忆查表单源（runToolCall isToolAllowed 装配双端共用）：
 * 按 (workspaceId, toolName) 取全部行——无 pattern 行即旧全等语义
 * （任意参数命中，保守缺省行为与旧一致）；pattern 行经
 * matchPermissionPattern 参数级匹配。命中行 fire-and-forget 回写
 * lastUsedAt（安全中心「90 天未用」治理数据源）。
 * workspaceId 缺席（未绑定会话/无任务图运行）恒 false。
 */
export async function isRememberedPermission(
  db: ToolPermissionDbLike,
  workspaceId: number | null | undefined,
  toolName: string,
  args?: unknown,
): Promise<boolean> {
  if (workspaceId == null) return false;
  const rows = await db.toolPermission.findMany({
    where: { workspaceId, toolName },
    select: { id: true, pattern: true },
  });
  for (const row of rows) {
    const hit =
      row.pattern == null || row.pattern.trim() === ""
        ? true
        : matchPermissionPattern(row.pattern, toolName, args);
    if (hit) {
      touchLastUsedAt(db, row.id);
      return true;
    }
  }
  return false;
}

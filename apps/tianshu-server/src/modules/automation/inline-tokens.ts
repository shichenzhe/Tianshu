/**
 * 内联引用 token 解析（闭包随行件，GA-T5）：自 mirror
 * src-react/domains/ai/chat/lib/inline-tokens.ts 整文件摘取——
 * automation runner 的引用解析（resolve-attachments）直接调用
 * parseInlineTokens（runner 闭包必需，GA-T4 acs3-sign/doc-extract
 * 「引用即需要」先例；偏差登记待 controller 追认）。
 * 纯函数零依赖，逐行保持（渲染段 renderTokenSegments/detectMention 等
 * 服务镜像层 pill 高亮，本仓无消费面，随文件保留以整文件零差异）。
 * - @文件:工作空间文件相对路径（@ 前须行首/空白）
 * - ⚡技能:已安装技能名
 * - /命令:内置命令词表（当前 compact）
 * - #待办:项目计划事项引用（#<数字 id>，标题/状态由消费方按 todoItems 解析）
 */
export interface TokenSegments {
  /** 移除全部 token 后的纯文本（首尾重整） */
  text: string;
  fileTokens: string[];
  skillTokens: string[];
  commands: string[];
  /** 待办引用 token（含 # 前缀原文，如 "#12"；id 解析由消费方完成） */
  todoTokens: string[];
}

/** 内置斜杠命令词表（/ 面板候选与 token 识别共用） */
export const SLASH_COMMANDS = ['compact'] as const;

/** token 整体（含符号前缀）：@path / ⚡name / /compact / #id；前导空白作边界 */
const TOKEN_RE =
  /(^|\s)(@[\w\-./]+|⚡[\w-]+|\/(?:compact)|#\d+(?!\d))(?![\w\-./])/g;

/** 解析输入文本：提取 token 并产出移除 token 后的消息文本 */
export function parseInlineTokens(input: string): TokenSegments {
  const fileTokens: string[] = [];
  const skillTokens: string[] = [];
  const commands: string[] = [];
  const todoTokens: string[] = [];
  let text = input.replace(TOKEN_RE, (_m, _lead: string, token: string) => {
    if (token.startsWith('@')) {
      fileTokens.push(token.slice(1));
    } else if (token.startsWith('⚡')) {
      skillTokens.push(token.slice(1));
    } else if (token.startsWith('#')) {
      todoTokens.push(token);
    } else {
      commands.push(token.slice(1));
    }
    return '';
  });
  // 收敛 token 移除后留下的多余空白（行内双空格/首尾）
  text = text
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .join('\n')
    .trim();
  return { text, fileTokens, skillTokens, commands, todoTokens };
}

/** 镜像层渲染分段：普通文本 / token（pill 样式由消费方赋予） */
export interface TokenSegment {
  text: string;
  isToken: boolean;
  /** 待办 token 专属标注（消费方据此映射标题；其余 token 形状不变） */
  kind?: 'todo';
}

/** 按同一 TOKEN_RE 切分文本（保留原文，含 token 本体与前导空白） */
export function renderTokenSegments(input: string): TokenSegment[] {
  const segments: TokenSegment[] = [];
  let last = 0;
  TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_RE.exec(input)) !== null) {
    const lead = match[1] ?? '';
    const start = match.index + lead.length;
    if (start > last) {
      segments.push({ text: input.slice(last, start), isToken: false });
    }
    const token = match[2] ?? '';
    segments.push(
      token.startsWith('#')
        ? { text: token, isToken: true, kind: 'todo' }
        : { text: token, isToken: true },
    );
    last = start + token.length;
  }
  if (last < input.length) {
    segments.push({ text: input.slice(last), isToken: false });
  }
  return segments;
}

/** 移除命令 token（文件/技能 token 保留：消息文本原样展示引用标记） */
export function stripCommandTokens(input: string): string {
  return input
    .replace(TOKEN_RE, (match, _lead: string, token: string) =>
      token.startsWith('/') ? '' : match,
    )
    .replace(/[^\S\n]+/g, ' ')
    .trim();
}

/** / 触发检测：光标前最近的 /token（前须行首/空白；token [\w-]*） */
export function detectSlash(
  value: string,
  caret: number,
): { startIndex: number; query: string } | null {
  const upto = value.slice(0, caret);
  const slash = upto.lastIndexOf('/');
  if (slash === -1) {
    return null;
  }
  const token = upto.slice(slash + 1);
  if (token.length > 0 && !/^[\w-]*$/.test(token)) {
    return null;
  }
  const prev = slash > 0 ? upto[slash - 1] : '';
  if (prev && !/\s/.test(prev)) {
    return null;
  }
  return { startIndex: slash, query: token };
}

/** @token 允许字符（@ 后连续输入的部分） */
export const MENTION_TOKEN_RE = /[\w\-./]/;

/** 切换 ⚡技能 引用（＋菜单技能子菜单消费）：未引用则末尾追加 token
 *  （保空白边界），已引用则按 TOKEN_RE 同边界语义全量移除并收敛空白 */
export function toggleSkillToken(input: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tokenRe = new RegExp(`(^|\\s)⚡${escaped}(?![\\w-])`, 'g');
  if (tokenRe.test(input)) {
    return input
      .replace(new RegExp(`(^|\\s)⚡${escaped}(?![\\w-])`, 'g'), '')
      .split('\n')
      .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
      .join('\n')
      .trim();
  }
  const sep = input === '' || /\s$/.test(input) ? '' : ' ';
  return `${input}${sep}⚡${name} `;
}

/** 联想面板候选上限（@ 文件、/ 技能与 # 待办面板共用） */
export const MENTION_LIMIT = 8;

/** 光标前最近的 @token：返回 @ 起始下标与 token 文本；无有效 token 返回 null */
export function detectMention(
  value: string,
  caret: number,
): { startIndex: number; query: string } | null {
  const upto = value.slice(0, caret);
  const at = upto.lastIndexOf('@');
  if (at === -1) {
    return null;
  }
  const token = upto.slice(at + 1);
  if (
    token.length > 0 &&
    ![...token].every((ch) => MENTION_TOKEN_RE.test(ch))
  ) {
    return null;
  }
  // @ 前必须是行首或空白（避免邮箱等误触）
  const prev = at > 0 ? upto[at - 1] : '';
  if (prev && !/\s/.test(prev)) {
    return null;
  }
  return { startIndex: at, query: token };
}

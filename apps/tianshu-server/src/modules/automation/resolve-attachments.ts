/**
 * 任务引用解析与注入（闭包随行件，GA-T5）：自 mirror
 * electron/domains/ai/automation/resolve-attachments.ts 摘取——runner 的
 * prompt 分流闭包必需（GA-T4 acs3-sign/doc-extract「引用即需要」先例，
 * 偏差登记待 controller 追认）：触发时读工作空间文件/技能最新内容，
 * 块前缀格式与 ChatView.handleSend 同构（[引用文件 <path>]\n<内容>）前缀
 * 注入——会话回看与产物面板解析天然兼容；正文为移除全部 token 后的文本
 * （与会话发送保留 token 的差异是有意为之）；技能聚焦（引用了只注入
 * 这些）；变量替换仅作用于用户正文段，引用内容原样。deps 全注入可测。
 *
 * GA-T5 改造点登记（其余逐行保持）：
 * 1. src-react inline-tokens → 本目录闭包随行件 ./inline-tokens
 * 2. chat/workspace-files 的 readWorkspaceFile/resolveFilePath → 本文件
 *    内最小面实现（该文件主体服务产物面板预览/文件窗保存 UI 面，不整摘；
 *    引用解析消费面仅需 text 判定 + 读取护栏，判定序与 mirror 同款）
 * 3. agent/skill-loader → server 副本 src/core/tools/skill-loader
 * 4. commons/paths appDataHome → resolveDataRoot（server 数据根
 *    TIANSHU_DATA_ROOT > ~/.tianshu-server，chat-runner 同源）
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { parseInlineTokens } from './inline-tokens';
import { loadSkills, type SkillInfo } from '../../core/tools/skill-loader';
import { resolveDataRoot } from '../../core/chat-runner.service';
import { replaceVariables } from './automation-runner';

export interface AttachmentBlock {
  kind: 'file' | 'skill';
  path: string;
  content: string;
}

export interface WorkspaceFileContent {
  kind: 'text' | 'image' | 'webview';
  content?: string;
  /** webview 类（html/pdf/音视频）：绝对路径（前端拼编码 file:// URL） */
  absPath?: string;
  size: number;
  /** 磁盘 mtime（ms） */
  mtime: number;
}

// —— 闭包最小面（改造点 2）：readWorkspaceFile/resolveFilePath ——

/** webview 类扩展名（与 mirror workspace-files 同清单）：不读内容 */
const WEBVIEW_EXTS = new Set([
  '.html',
  '.htm',
  '.pdf',
  '.mp3',
  '.wav',
  '.ogg',
  '.m4a',
  '.flac',
  '.mp4',
  '.mov',
  '.avi',
  '.mkv',
  '.webm',
]);

/** 图片扩展名先行识别清单（mirror IMAGE_MIME 键集）；引用解析不消费
 * base64（非 text kind 与缺失同义），仅保 10MB 上限判定序 */
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);

const READ_LIMIT = 512 * 1024;

/** 图片读取上限：10MB（对齐 mirror；文本候选仍 512KB） */
export const IMAGE_READ_LIMIT = 10 * 1024 * 1024;

export function resolveFilePath(
  workspacePath: string,
  relPath: string,
): string {
  return path.isAbsolute(relPath)
    ? path.resolve(relPath)
    : path.resolve(workspacePath, relPath);
}

/**
 * 工作空间文件读取（mirror chat/workspace-files readWorkspaceFile 的最小
 * 面）：stat → webview 扩展名先行（不读内容）→ 图片扩展名先行（10MB
 * 上限，kind=image）→ 512KB 文本上限 + NUL 二进制判定（kind=text）。
 * 引用解析只认 kind=text 的 content，其余 kind 与读取抛错同义由调用方
 * 归一为 attachment_missing。
 */
export async function readWorkspaceFile(
  absPath: string,
): Promise<WorkspaceFileContent> {
  const stat = await fs.stat(absPath);
  if (!stat.isFile()) throw new Error('目标是目录，无法预览');
  const ext = path.extname(absPath).toLowerCase();
  if (WEBVIEW_EXTS.has(ext)) {
    return { kind: 'webview', absPath, size: stat.size, mtime: stat.mtimeMs };
  }
  if (IMAGE_EXTS.has(ext)) {
    if (stat.size > IMAGE_READ_LIMIT) {
      throw new Error('图片超过 10MB 上限');
    }
    return { kind: 'image', size: stat.size, mtime: stat.mtimeMs };
  }
  if (stat.size > READ_LIMIT) throw new Error('文件超过 512KB 预览上限');
  const buf = await fs.readFile(absPath);
  if (buf.includes(0)) {
    throw new Error('该格式暂不支持预览，请另存查看');
  }
  return {
    kind: 'text',
    content: buf.toString('utf-8'),
    size: stat.size,
    mtime: stat.mtimeMs,
  };
}

export interface ResolveDeps {
  readWorkspaceFile: typeof readWorkspaceFile;
  loadSkills: typeof loadSkills;
  readSkillFile: (skillMdPath: string) => Promise<string>;
  skillsRootDir: () => string;
}

export const defaultResolveDeps: ResolveDeps = {
  readWorkspaceFile,
  loadSkills,
  // SkillInfo.bodyPath 即 SKILL.md 绝对路径；>256K 字符截断加后缀
  // （同 skill.repo readSkill 护栏，防超长技能正文撑爆注入上下文）
  readSkillFile: async (skillMdPath) => {
    const content = await fs.readFile(skillMdPath, 'utf8');
    return content.length > 256 * 1024
      ? `${content.slice(0, 256 * 1024)}…(已截断)`
      : content;
  },
  // 改造点 4：server 数据根（TIANSHU_DATA_ROOT > ~/.tianshu-server）
  skillsRootDir: () => resolveDataRoot('~/.tianshu-server'),
};

/**
 * 块前缀格式与 ChatView.handleSend 同构：块间 \n\n，整体后接 \n\n + 正文；
 * 正文为移除 token 后的文本（与会话发送保留 token 的差异是有意为之）
 */
export function composeInjectedPrompt(
  userText: string,
  blocks: AttachmentBlock[],
): string {
  if (blocks.length === 0) {
    return userText;
  }
  return `${blocks
    .map((b) =>
      b.kind === 'skill'
        ? `[引用技能 ${b.path}]\n${b.content}`
        : `[引用文件 ${b.path}]\n${b.content}`,
    )
    .join('\n\n')}\n\n${userText}`;
}

export type AttachmentsResolution =
  | { injected: string; skills: SkillInfo[]; referenced: boolean }
  | { error: string };

export async function resolveAttachments(
  prompt: string,
  workspacePath: string | undefined,
  now: Date,
  deps: ResolveDeps = defaultResolveDeps,
): Promise<AttachmentsResolution> {
  const { text, fileTokens, skillTokens } = parseInlineTokens(prompt);
  const blocks: AttachmentBlock[] = [];
  try {
    for (const filePath of new Set(fileTokens)) {
      if (!workspacePath) {
        return { error: `attachment_missing: ${filePath}` };
      }
      const abs = resolveFilePath(workspacePath, filePath);
      let content: string | undefined;
      try {
        const result = await deps.readWorkspaceFile(abs);
        if (result.kind === 'text') {
          content = result.content;
        }
      } catch {
        // 读取抛错（ENOENT/EACCES 竞态等）：与缺失同义，报该文件路径
      }
      if (content === undefined) {
        return { error: `attachment_missing: ${filePath}` };
      }
      blocks.push({ kind: 'file', path: filePath, content });
    }
    const allSkills = deps.loadSkills([
      {
        dir: path.join(deps.skillsRootDir(), 'skills'),
        source: 'user',
      },
      // workspace 级 source 用 "workspace"（照搬 runner streamAndRecord 现码，
      // 对齐 chat.service collectSkills：同名用户级胜，来源标记供 UI 区分）
      ...(workspacePath
        ? [
            {
              dir: path.join(workspacePath, '.tianshu', 'skills'),
              source: 'workspace' as const,
            },
          ]
        : []),
    ]);
    for (const name of new Set(skillTokens)) {
      const skill = allSkills.find((s) => s.name === name);
      if (!skill || !skill.dir) {
        return { error: `attachment_missing: skill ${name}` };
      }
      let content: string | undefined;
      try {
        // bodyPath 由 loadSkills 拼好（SKILL.md 绝对路径），直接用
        content = await deps.readSkillFile(skill.bodyPath);
      } catch {
        // SKILL.md 读取抛错：与技能缺失同义，报该技能名
      }
      if (content === undefined) {
        return { error: `attachment_missing: skill ${name}` };
      }
      blocks.push({ kind: 'skill', path: name, content });
    }
    const referenced = skillTokens.length > 0;
    const skills = referenced
      ? allSkills.filter((s) => new Set(skillTokens).has(s.name))
      : allSkills;
    return {
      injected: composeInjectedPrompt(replaceVariables(text, now), blocks),
      skills,
      referenced,
    };
  } catch {
    return { error: 'attachment_missing: read failed' };
  }
}

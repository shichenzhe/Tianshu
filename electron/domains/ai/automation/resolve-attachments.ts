/**
 * 任务引用解析与注入(spec §2):触发时读工作空间文件/技能最新内容,
 * 块前缀格式与 ChatView.handleSend 同构([引用文件 <path>]\n<内容>)前缀
 * 注入——会话回看与产物面板解析天然兼容;正文为移除全部 token 后的文本
 * (与会话发送保留 token 的差异是有意为之);技能聚焦(引用了只注入这些);
 * 变量替换仅作用于用户正文段,引用内容原样。deps 全注入可测。
 */
import path from "node:path";
import fs from "node:fs/promises";
import { app } from "electron";
import { parseInlineTokens } from "../../../../src-react/domains/ai/chat/lib/inline-tokens";
import { readWorkspaceFile, resolveFilePath } from "../chat/workspace-files";
import { loadSkills, type SkillInfo } from "../agent/skill-loader";
import { replaceVariables } from "./automation-runner";

export interface AttachmentBlock {
  kind: "file" | "skill";
  path: string;
  content: string;
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
  // SkillInfo.bodyPath 即 SKILL.md 绝对路径;>256K 字符截断加后缀
  // (同 skill.repo readSkill 护栏,防超长技能正文撑爆注入上下文)
  readSkillFile: async (skillMdPath) => {
    const content = await fs.readFile(skillMdPath, "utf8");
    return content.length > 256 * 1024
      ? `${content.slice(0, 256 * 1024)}…(已截断)`
      : content;
  },
  skillsRootDir: () => app.getPath("userData"),
};

/**
 * 块前缀格式与 ChatView.handleSend 同构:块间 \n\n,整体后接 \n\n + 正文;
 * 正文为移除 token 后的文本(与会话发送保留 token 的差异是有意为之)
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
      b.kind === "skill"
        ? `[引用技能 ${b.path}]\n${b.content}`
        : `[引用文件 ${b.path}]\n${b.content}`,
    )
    .join("\n\n")}\n\n${userText}`;
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
        if (result.kind === "text") {
          content = result.content;
        }
      } catch {
        // 读取抛错(ENOENT/EACCES 竞态等):与缺失同义,报该文件路径
      }
      if (content === undefined) {
        return { error: `attachment_missing: ${filePath}` };
      }
      blocks.push({ kind: "file", path: filePath, content });
    }
    const allSkills = deps.loadSkills([
      {
        dir: path.join(deps.skillsRootDir(), "skills"),
        source: "user",
      },
      // workspace 级 source 用 "workspace"(照搬 runner streamAndRecord 现码,
      // 对齐 chat.service collectSkills:同名用户级胜,来源标记供 UI 区分)
      ...(workspacePath
        ? [
            {
              dir: path.join(workspacePath, ".tianshu", "skills"),
              source: "workspace" as const,
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
        // bodyPath 由 loadSkills 拼好(SKILL.md 绝对路径),直接用
        content = await deps.readSkillFile(skill.bodyPath);
      } catch {
        // SKILL.md 读取抛错:与技能缺失同义,报该技能名
      }
      if (content === undefined) {
        return { error: `attachment_missing: skill ${name}` };
      }
      blocks.push({ kind: "skill", path: name, content });
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
    return { error: "attachment_missing: read failed" };
  }
}

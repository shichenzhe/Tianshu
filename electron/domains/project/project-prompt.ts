/**
 * 项目提示词组装（项目模块一期 spec §5）：纯函数、无 IO——
 * 项目 systemPrompt + 挂载专家 prompt + 会话所选助手 prompt 合并为
 * 会话 system base，挂载能力为预设（软约束引导优先，非硬边界）
 */

/** 项目提示词上下文（ProjectRepository.getPromptContext 产出） */
export interface ProjectPromptContext {
  /** 项目名 */
  projectName: string;
  /** 项目级系统提示词 */
  systemPrompt: string | null;
  /** 已挂载专家的 systemPrompt（按挂载顺序） */
  boundAssistantPrompts: string[];
  /** 已挂载技能名（软约束声明用） */
  boundSkillNames: string[];
  /** 已挂载连接器名 */
  boundConnectorNames: string[];
}

/**
 * 预设能力声明（软约束）：挂载集是默认起点而非围墙——模型优先用
 * 预设，用户在会话中要求用预设外的技能/连接器时按需直接调用
 */
function buildCapabilitySection(
  skillNames: string[],
  connectorNames: string[],
): string {
  if (skillNames.length === 0 && connectorNames.length === 0) return "";
  const lines = ["【项目预设能力】"];
  if (skillNames.length > 0) lines.push(`技能：${skillNames.join("、")}`);
  if (connectorNames.length > 0) {
    lines.push(`连接器：${connectorNames.join("、")}`);
  }
  lines.push(
    "以上为本项目预设能力，对话中请优先使用；用户要求使用预设外的技能或连接器时，可按需直接调用。",
  );
  return lines.join("\n");
}

/**
 * 项目会话 base system：项目指令 + 挂载专家（预设）+ 会话所选助手
 * prompt 合并（会话中切换助手即时生效，预设专家仍叠加在场）；
 * 全部为空则 undefined（调用方回退）
 */
export function buildProjectSystemBase(
  ctx: ProjectPromptContext,
  sessionAssistantPrompt?: string | null,
): string | undefined {
  const capabilitySection = buildCapabilitySection(
    ctx.boundSkillNames,
    ctx.boundConnectorNames,
  );
  return (
    [
      ctx.systemPrompt,
      ...ctx.boundAssistantPrompts,
      sessionAssistantPrompt ?? null,
      capabilitySection,
    ]
      .filter(Boolean)
      .join("\n\n") || undefined
  );
}

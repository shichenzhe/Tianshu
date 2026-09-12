/**
 * 项目提示词组装（项目模块一期 spec §5）：纯函数、无 IO——
 * 项目 systemPrompt + 挂载专家 prompt 合并为会话 system base，
 * 有挂载能力时附加软约束声明段（硬隔离二期落地）
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

/** 可用能力软约束（一期）：硬隔离二期落地 */
function buildCapabilitySection(
  skillNames: string[],
  connectorNames: string[],
): string {
  if (skillNames.length === 0 && connectorNames.length === 0) return "";
  const lines = ["【本项目可用能力】"];
  if (skillNames.length > 0) lines.push(`技能：${skillNames.join("、")}`);
  if (connectorNames.length > 0) {
    lines.push(`连接器：${connectorNames.join("、")}`);
  }
  lines.push("本项目对话中请优先（且仅）使用以上已挂载能力。");
  return lines.join("\n");
}

/** 项目会话 base system：项目指令 + 专家 prompt 合并；空则 undefined */
export function buildProjectSystemBase(
  ctx: ProjectPromptContext,
): string | undefined {
  const capabilitySection = buildCapabilitySection(
    ctx.boundSkillNames,
    ctx.boundConnectorNames,
  );
  return (
    [ctx.systemPrompt, ...ctx.boundAssistantPrompts, capabilitySection]
      .filter(Boolean)
      .join("\n\n") || undefined
  );
}

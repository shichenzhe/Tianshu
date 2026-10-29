/**
 * 工具分组场景门控（spec §20 项 B，学 WorkBuddy「窄常驻 + 按需挂载」）：
 * 注入层按会话场景收窄工具面——核心组恒注入，工作流/专家组按需挂载。
 * 与 SP6 disabledTools 叠加两层（场景门控先、用户禁用后），独立于用户
 * 禁用配置：场景映射是产品/token 语义而非安全语义（工具执行侧门禁
 * 与历史 tool_call 回喂均不受影响，禁用=对模型不存在的注入语义同 SP6）。
 * 纯函数零依赖（不 import electron/prisma）：判定输入 ToolGroupGate 由
 * ChatService.assembleContext 装配（先例 tool-registry.filterDisabledTools）。
 */

/**
 * 核心组（恒注入）：file 5 + browser 4 + browse + bash +
 * fetch + create_skill + read_skill——任何 agent 会话的常驻最小面。
 * 仅作文档/测试对照：门控实现是「两组门控组之外一律放行」的黑名单式，
 * mcp 前缀与技能挂载工具等照旧注入，新增工具不会因不在核心组被误剔
 */
export const CORE_TOOL_NAMES: readonly string[] = [
  "read",
  "write",
  "ls",
  "grep",
  "rm",
  "browser_snapshot",
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browse",
  "bash",
  "fetch",
  "create_skill",
  "read_skill",
];

/**
 * 工作流组（按需）：automation/coding 场景或 workflow-creator 技能已安装
 * 且启用时挂载。名字与 graph.repo 静态注册名一一对应——2026-10-29 工具
 * 名精简批次六件坍缩四件（create+update→workflow_write、list+get→
 * workflow_read、run 双件保留），反转 2026-10-14 spec §20 项 C「不可改」
 * 裁定：老名断回喂之忧由 @tianshu/core tool-alias 别名层兜底（历史
 * blocks 老 tool_call 经归一由新名工具执行，DB 不迁移）
 */
export const WORKFLOW_GROUP_TOOL_NAMES: readonly string[] = [
  "workflow_write",
  "workflow_read",
  "run_workflow",
  "get_workflow_run",
];

/** 专家组（按需）：专家绑定会话挂载（专家 2.0 管理动作集中在绑定语境） */
export const EXPERT_GROUP_TOOL_NAMES: readonly string[] = [
  "create_expert",
  "update_expert",
];

/**
 * 工作流组中无工作空间依赖的三件（workflow_write/workflow_read/
 * get_workflow_run——用户级 DB 实体，只按 userId 落库查询，与
 * create_skill「不依赖工作空间常驻」同语义）：未绑定目录会话经
 * 场景/意图开门后照常挂载（挂载元说明的承诺由此兑现）；run_workflow
 * 除外——试运行需工作空间语境（fileRead/fileWrite 等节点落地），
 * 绑定目录后可用
 */
export const WORKFLOW_NO_WORKSPACE_TOOLS: ReadonlySet<string> = new Set(
  WORKFLOW_GROUP_TOOL_NAMES.filter((n) => n !== "run_workflow"),
);

/**
 * 工作流组挂载的技能名：用户侧安装（source!=="builtin"——内置技能启动
 * 自愈安装且 enabled 默认 true，内置态不开门，spec §20 项 B 注）且启用
 * （skillRecord.enabled）即视为挂载信号；三列清单由 skillRepo.listGateStatus
 * 单查询提供（builtin-skills BUILTIN_SKILL_NAMES 同名）
 */
export const WORKFLOW_CREATOR_SKILL_NAME = "workflow-creator";

/** 工作流组挂载场景（session.scenario 现值域 daily/coding/design；
 *  automation 为预留值——按值判定，值域扩展零改动） */
const WORKFLOW_SCENARIOS: ReadonlySet<string> = new Set([
  "automation",
  "coding",
]);

/** 专家组挂载场景（experts 为预留值） */
const EXPERT_SCENARIOS: ReadonlySet<string> = new Set(["experts"]);

/**
 * 门控判定输入（assembleContext 装配）：scenario = session.scenario
 * （null/undefined=未选场景）；assistantBound = session.assistantId 非空；
 * workflowCreatorEnabled 三信号取或（chat.service 装配）：会话内
 * read_skill 读过 workflow-creator（使用即意图）/ 用户侧安装
 * （source!=="builtin"）且启用 —— f49349d7 自愈纠存量 source 后
 * 内置态恒 builtin，第二信号对普通用户永假，第一信号恢复可达性
 */
export interface ToolGroupGate {
  scenario?: string | null;
  assistantBound: boolean;
  workflowCreatorEnabled: boolean;
}

/**
 * 工作流组是否挂载：场景命中（automation/coding）或 workflowCreatorEnabled
 * 三信号取或——filterToolsBySession 同口径判定，导出供 chat.service 挂载
 * 元说明注入条件复用（口径漂移即元说明误报/漏报）
 */
export function isWorkflowGroupAllowed(gate: ToolGroupGate): boolean {
  return (
    WORKFLOW_SCENARIOS.has(gate.scenario ?? "") || gate.workflowCreatorEnabled
  );
}

/**
 * 场景门控（collectToolDefinitions 收口处、filterDisabledTools 之内层）：
 * 门控组按 gate 放行/剔除，其余工具一律放行并保持原相对次序
 */
export function filterToolsBySession<T extends { name: string }>(
  defs: T[],
  gate: ToolGroupGate,
): T[] {
  const workflowAllowed = isWorkflowGroupAllowed(gate);
  const expertAllowed =
    EXPERT_SCENARIOS.has(gate.scenario ?? "") || gate.assistantBound;
  const workflowGroup = new Set(WORKFLOW_GROUP_TOOL_NAMES);
  const expertGroup = new Set(EXPERT_GROUP_TOOL_NAMES);
  return defs.filter((def) => {
    if (workflowGroup.has(def.name)) {
      return workflowAllowed;
    }
    if (expertGroup.has(def.name)) {
      return expertAllowed;
    }
    return true;
  });
}

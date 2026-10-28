/**
 * 项目数据接口
 * 前后端共享的项目/能力挂载/详情数据结构（项目模块一期 spec §4）
 */
import type { SessionRecord } from "../../../src-react/domains/ai/api/session.api";

/**
 * 能力挂载类型：assistant 智能体 / skill 技能 / mcpServer MCP 服务器
 */
export type ProjectBindingType = "assistant" | "skill" | "mcpServer";

/**
 * 能力挂载写入参数
 */
export interface ProjectBindingInput {
  /**
   * 挂载类型
   */
  itemType: ProjectBindingType;

  /**
   * 源实体 id（assistant/skillRecord/mcpServer 表主键）
   */
  itemId: number;
}

/**
 * 项目记录（DateTime 已转 ISO 字符串）
 */
export interface ProjectRecord {
  /**
   * 项目 id
   */
  id: number;

  /**
   * 项目名（同 owner 下唯一）
   */
  name: string;

  /**
   * 项目级系统提示词
   */
  systemPrompt: string | null;

  /**
   * 创建时使用的模版 key
   */
  templateKey: string | null;

  /**
   * 创建人（owner）用户 id
   */
  ownerId: number;

  /**
   * 项目动态流会话 id
   */
  sessionId: number;

  /**
   * 创建时间（ISO）
   */
  createdAt: string;

  /**
   * 更新时间（ISO）
   */
  updatedAt: string;
}

/**
 * 能力挂载展示项（详情返回结构）
 */
export interface ProjectBindingItem {
  /**
   * 挂载行 id
   */
  id: number;

  /**
   * 挂载类型
   */
  itemType: ProjectBindingType;

  /**
   * 源实体 id
   */
  itemId: number;

  /**
   * 源实体显示名；源被删时保留最后已知名
   */
  itemName: string;

  /**
   * 源实体是否存在
   */
  valid: boolean;
}

/**
 * 项目详情：项目 + 资产空间 + 能力挂载 + 动态流会话
 */
export interface ProjectDetail {
  /**
   * 项目记录
   */
  project: ProjectRecord;

  /**
   * 资产空间 workspace id（前端资产文件操作 / @ 引用定位用，二期 §3.2）
   */
  assetWorkspaceId: number;

  /**
   * 能力挂载列表
   */
  bindings: ProjectBindingItem[];

  /**
   * 动态流会话（复用 ai 域 SessionRecord）
   */
  session: SessionRecord;
}

/**
 * 项目创建参数
 */
export interface ProjectCreateParams {
  /**
   * 创建人用户 id（v12 起主进程以 token 解出的用户为准，可缺省）
   */
  ownerId?: number;

  /**
   * 项目名
   */
  name: string;

  /**
   * 项目级系统提示词
   */
  systemPrompt?: string;

  /**
   * 创建模版 key
   */
  templateKey?: string;

  /**
   * 动态流欢迎消息（空则不写）
   */
  welcomeMessage?: string;

  /**
   * 初始能力挂载
   */
  bindings?: ProjectBindingInput[];
}

/**
 * 项目更新参数
 */
export interface ProjectUpdateParams {
  /**
   * 项目 id
   */
  id: number;

  /**
   * 新项目名（改名时校验同用户重名）
   */
  name?: string;

  /**
   * 新项目级系统提示词
   */
  systemPrompt?: string;
}

/**
 * 错误码：同用户下项目名已存在
 */
export const PROJECT_NAME_EXISTS = "PROJECT_NAME_EXISTS";

/**
 * 错误码：项目不存在
 */
export const PROJECT_NOT_FOUND = "PROJECT_NOT_FOUND";

/**
 * 项目成员列表项（计划模块处理人选择器用，子系统 A）
 */
export interface ProjectMemberItem {
  /**
   * 用户 id
   */
  userId: number;

  /**
   * 昵称（缺省回退用户名）
   */
  nickname: string;

  /**
   * 用户名
   */
  username: string;

  /**
   * 角色：owner | member
   */
  role: string;
}

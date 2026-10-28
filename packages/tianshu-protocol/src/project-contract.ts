// packages/tianshu-protocol/src/project-contract.ts
/** A7 项目批自桌面 project 域 entity 收编（单份权威源）。
 *  远程载荷刻意剔除 ownerId/createdById——身份唯一来源 withUserId；
 *  ProjectDetail 远程只带 sessionId，不耦合完整聊天会话形状。 */

/** 能力挂载类型：assistant 智能体 / skill 技能 / mcpServer MCP 服务器 */
export type ProjectBindingType = "assistant" | "skill" | "mcpServer";

/** 项目记录（DateTime 已转 ISO 字符串；镜像桌面 ProjectRecord） */
export interface ProjectRecordDto {
  id: number;
  name: string;
  systemPrompt: string | null;
  templateKey: string | null;
  ownerId: number;
  sessionId: number;
  createdAt: string;
  updatedAt: string;
}

/** 能力挂载展示项（源被删时 itemName="#id"、valid=false） */
export interface ProjectBindingItemDto {
  id: number;
  itemType: ProjectBindingType;
  itemId: number;
  itemName: string;
  valid: boolean;
}

/** 项目详情远程出参：会话只带 id（资产预览用 assetWorkspaceId 走 files/*） */
export interface ProjectDetailResult {
  project: ProjectRecordDto;
  assetWorkspaceId: number;
  bindings: ProjectBindingItemDto[];
  sessionId: number;
}

/** 远程创建载荷：无 ownerId（身份来自 token）；bindings 写面另批不带 */
export interface ProjectCreatePayload {
  name: string;
  systemPrompt?: string;
  templateKey?: string;
  welcomeMessage?: string;
}

export interface ProjectUpdatePayload {
  id: number;
  name?: string;
  systemPrompt?: string;
}

export interface ProjectMemberItemDto {
  userId: number;
  nickname: string;
  username: string;
  role: string;
}

export const PLAN_STATUSES = [
  "not_started",
  "in_progress",
  "paused",
  "done",
] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const PLAN_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export type PlanPriority = (typeof PLAN_PRIORITIES)[number];

export const PLAN_SOURCES = ["manual", "ai", "template"] as const;
export type PlanItemSource = (typeof PLAN_SOURCES)[number];

/** 计划事项记录（镜像桌面 PlanItemRecord；日期空串 = 无） */
export interface PlanItemRecordDto {
  id: number;
  projectId: number | null;
  title: string;
  description: string;
  aiSummary: string;
  status: PlanStatus;
  priority: PlanPriority;
  assigneeId: number | null;
  tags: string[];
  customFields: Record<string, string | number>;
  startDate: string;
  dueDate: string;
  source: PlanItemSource;
  sortOrder: number;
  createdById: number;
  createdAt: string;
  updatedAt: string;
}

/** 附件关联记录（assetPath 为项目 workspace 相对路径） */
export interface PlanItemAttachmentRecordDto {
  id: number;
  planItemId: number;
  fileName: string;
  assetPath: string;
  createdAt: string;
}

/** 远程创建载荷：无 createdById；projectId 缺省 = 本地任务 */
export interface PlanItemCreatePayload {
  title: string;
  description?: string | null;
  projectId?: number;
  status?: PlanStatus;
  priority?: PlanPriority;
  assigneeId?: number | null;
  tags?: string[];
  customFields?: Record<string, string | number>;
  source?: PlanItemSource;
  startDate?: string | null;
  dueDate?: string | null;
}

/** 局部更新：未传键不覆盖；description/startDate/dueDate 传 null/空串 = 清空 */
export interface PlanItemUpdatePayload {
  id: number;
  title?: string;
  description?: string | null;
  status?: PlanStatus;
  priority?: PlanPriority;
  assigneeId?: number | null;
  tags?: string[];
  customFields?: Record<string, string | number>;
  source?: PlanItemSource;
  startDate?: string | null;
  dueDate?: string | null;
}

/** 状态流转：跨列落点（目标列内新序由服务端列尾语义或前端全量缓存计算） */
export interface PlanItemMovePayload {
  id: number;
  status: PlanStatus;
  sortOrder: number;
}

export const PLAN_FIELD_TYPES = ["text", "number", "date"] as const;
export type PlanFieldType = (typeof PLAN_FIELD_TYPES)[number];

export interface PlanFieldDefDto {
  name: string;
  type: PlanFieldType;
}

export const PLAN_VIEW_TYPES = [
  "table",
  "kanban",
  "list",
  "gantt",
  "calendar",
] as const;
export type PlanViewType = (typeof PLAN_VIEW_TYPES)[number];

export const PLAN_GROUP_BYS = ["status", "priority", "assignee"] as const;
export type PlanGroupBy = (typeof PLAN_GROUP_BYS)[number];

/** 视图记录（只读消费；filterJson/sortJson 解析交给 core 纯函数引擎） */
export interface PlanViewRecordDto {
  id: number;
  projectId: number;
  name: string;
  type: PlanViewType;
  groupBy: PlanGroupBy | null;
  filterJson: string;
  sortJson: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** 资产条目（目录树行） */
export interface AssetEntryDto {
  name: string;
  type: "file" | "folder";
  size: number;
  updatedAt: string;
  ext: string;
}

export interface AssetStorageDto {
  usedBytes: number;
  quotaBytes: number;
}

export interface ProjectAssetListPayload {
  projectId: number;
  path?: string;
}

export interface ProjectAssetCreateFolderPayload {
  projectId: number;
  parentPath: string;
  name: string;
}

export interface ProjectAssetRenamePayload {
  projectId: number;
  path: string;
  newName: string;
}

export interface ProjectAssetDeletePayload {
  projectId: number;
  path: string;
}

export interface ProjectAssetReadImagePayload {
  projectId: number;
  path: string;
}

/** 项目域稳定错误码（face 透传，移动端按码提示） */
export const PROJECT_ERROR_CODES = [
  "PROJECT_NOT_FOUND",
  "PROJECT_NAME_EXISTS",
  "PLAN_ITEM_NOT_FOUND",
  "PLAN_VIEW_LAST_ONE",
  "ASSET_PATH_ESCAPE",
  "ASSET_NOT_FOUND",
  "ASSET_NAME_INVALID",
] as const;
export type ProjectErrorCode = (typeof PROJECT_ERROR_CODES)[number];

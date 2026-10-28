// packages/tianshu-protocol/src/skill-contract.ts
/** A3 批收编：技能管理扩展 + SkillHub 市场契约（单份权威源）。
 *  SkillHub 远端形状与 desktop skillhub-client.ts 同构；zip 由被控宿主
 *  下载安装，移动端只传查询参数/slug，零流量。 */

/** 技能场景三值（与桌面 setScenarios 同口径） */
export const SKILL_SCENARIOS = ["daily", "coding", "design"] as const;
export type SkillScenario = (typeof SKILL_SCENARIOS)[number];

/** skills/query 增量扩展（RemoteSkillBrief 增补可选段——既有消费方不受影响） */
export interface SkillBriefExtension {
  scenarios?: SkillScenario[];
  source?: string;
  /** 内置技能拒卸载（服务端判定口径） */
  builtin?: boolean;
}

export interface SkillSetScenariosPayload {
  name: string;
  scenarios: SkillScenario[];
}

export interface SkillUninstallPayload {
  name: string;
}

/** A3 尾：skills/installUpload 载荷——base64 zip（服务端解码 ≤3MB 校验，
 *  同 files/uploadImage 3MB 口径；name 为客户端文件名，仅展示/报错用，
 *  落盘技能名以包内 SKILL.md frontmatter 为准；overwrite——冲突覆写确认
 *  后二次请求带 true，缺省 false 冲突返回 {status:"conflict"}） */
export interface SkillsInstallUploadPayload {
  name: string;
  base64: string;
  overwrite?: boolean;
}

/** A3 尾：skills/stats 统计项——skillStat 事件表聚合（usedCount = 该技能
 *  全部埋点事件计数合计——install/create/enable/disable/uninstall/batch_*；
 *  lastUsedAt = 最新事件时间 ISO，无事件 null） */
export interface SkillStatItem {
  name: string;
  usedCount: number;
  lastUsedAt: string | null;
}

/** SkillHub 市场条目（与 desktop skillhub-client SkillHubSkill 同构） */
export interface SkillHubSkillDto {
  slug: string;
  name: string;
  description: string;
  description_zh: string;
  iconUrl: string | null;
  category: string;
  version: string;
  downloads: number;
  stars: number;
  score: number;
  source: string;
  /** hub list/top 行原生蛇形 created_at（epoch ms）经 repo 映射 camel 透出；
   *  旧被控端无此字段——可选段宽容（消费端排序缺值沉底） */
  createdAt?: number;
}

export interface SkillHubCategoryDto {
  key: string;
  name: string;
  nameEn: string;
  sortOrder: number;
}

export interface SkillHubListPayload {
  keyword?: string;
  category?: string;
  page?: number;
  pageSize?: number;
  sortBy?: string;
  order?: "asc" | "desc";
}

export interface SkillHubPageDto {
  total: number;
  skills: SkillHubSkillDto[];
}

export interface SkillHubInstallPayload {
  slug: string;
  overwrite?: boolean;
}

/** 宿主安装结果（与 desktop skill-installer InstallResult 同构） */
export type SkillInstallResultDto =
  | {
      status: "installed";
      record: {
        id: number;
        name: string;
        source: string;
        slug: string | null;
        version: string | null;
      };
    }
  | { status: "conflict"; name: string };

/** SkillHub 安全检测归一（repo 归一 hub securityReports 双源报告为单值）：
 *  benign=全部报告 benign / caution=存在非 benign / unknown=无报告——
 *  移动端零报告形状知识，仅本地化文案与徽标 */
export type SkillHubSecurityStatus = "benign" | "caution" | "unknown";

/** SkillHub 详情统计（hub skill.stats 消费面） */
export interface SkillHubDetailStatsDto {
  downloads: number;
  installs: number;
  stars: number;
  versions: number;
  comments: number;
}

/** SkillHub 详情（hub /api/v1/skills/{slug} 消费面——只声明消费字段，
 *  全可选段宽容形状演进；owner/latestVersion 缺失归 null；security 为
 *  repo 侧归一值恒在） */
export interface SkillHubDetailDto {
  skill: {
    slug: string;
    displayName?: string;
    category?: string;
    iconUrl?: string | null;
    summary?: string;
    summary_zh?: string;
    /** 正文 Markdown——hasOverview:false 时为空串，消费端按空占位 */
    overviewMd?: string;
    hasOverview?: boolean;
    createdAt?: number;
    source?: string;
    sourceUrl?: string;
    stats?: SkillHubDetailStatsDto;
  };
  owner: { displayName: string; handle: string; image: string | null } | null;
  latestVersion: {
    version: string;
    changelog?: string;
    createdAt?: number;
  } | null;
  security: SkillHubSecurityStatus;
}

export const SKILL_ERROR_CODES = [
  "SKILL_NOT_FOUND",
  "SKILL_BUILTIN",
  "SKILLHUB_UNAVAILABLE",
  // A3 尾：zip 上传面——base64 解码失败/超 3MB 上限/包结构不合法
  "SKILL_UPLOAD_INVALID",
] as const;
export type SkillErrorCode = (typeof SKILL_ERROR_CODES)[number];

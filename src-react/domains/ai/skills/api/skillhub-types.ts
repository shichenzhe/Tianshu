/**
 * SkillHub 市场数据类型(与 electron/domains/ai/skill/skillhub-client.ts 保持同步;
 * 独立声明避免渲染进程 import 主进程模块)
 */
export interface SkillHubSkill {
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
}

export interface SkillHubCategory {
  key: string;
  name: string;
  nameEn: string;
  sortOrder: number;
}

export interface SkillHubListParams {
  keyword?: string;
  category?: string;
  page?: number;
  pageSize?: number;
  sortBy?: string;
  order?: "asc" | "desc";
}

export interface SkillHubPage {
  total: number;
  skills: SkillHubSkill[];
}

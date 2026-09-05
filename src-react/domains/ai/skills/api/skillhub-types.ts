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

/**
 * 安装结果(与 electron/domains/ai/skill/skill-installer.ts 的 InstallResult
 * 保持同步;独立声明避免渲染进程 import 主进程模块)
 */
export type InstallResult =
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

/**
 * dryRun 预检结果(与 electron/domains/ai/skill/skill-installer.ts 的
 * InspectResult 保持同步;独立声明避免渲染进程 import 主进程模块)
 */
export type InspectResult =
  | { status: "ok"; name: string; description: string }
  | { status: "conflict"; name: string };

/**
 * SkillHub 形状映射纯函数（detail 批）：hub 蛇形 created_at → 协议 camel
 * createdAt；detail 裸对象 → SkillHubDetailDto（securityReports 双源报告
 * 归一单值 benign/caution/unknown）。零 electron 依赖，可直测。
 */
import type {
  SkillHubDetailDto,
  SkillHubSecurityStatus,
  SkillHubSkillDto,
} from "@tianshu/protocol";
import type { SkillHubSkill, SkillHubSkillDetail } from "./skillhub-client";

/** hub list/top 行 → 协议市场条目（蛇形 created_at 剔除、camel 透出） */
export function mapHubSkill(row: SkillHubSkill): SkillHubSkillDto {
  const { created_at: createdAt, ...rest } = row;
  return { ...rest, createdAt };
}

/** 双源安全报告归一：全 benign→benign；存在非 benign→caution；无报告→unknown */
export function normalizeHubSecurity(
  reports: SkillHubSkillDetail["securityReports"],
): SkillHubSecurityStatus {
  const statuses = Object.values(reports ?? {})
    .map((report) => report?.status)
    .filter((status): status is string => typeof status === "string");
  if (statuses.length === 0) return "unknown";
  return statuses.every((status) => status === "benign") ? "benign" : "caution";
}

/** hub detail 裸对象 → 协议详情 DTO（owner/latestVersion 缺失归 null） */
export function mapHubDetail(detail: SkillHubSkillDetail): SkillHubDetailDto {
  return {
    skill: {
      slug: detail.skill.slug,
      displayName: detail.skill.displayName,
      category: detail.skill.category,
      iconUrl: detail.skill.iconUrl ?? null,
      summary: detail.skill.summary,
      summary_zh: detail.skill.summary_zh,
      overviewMd: detail.skill.overviewMd,
      hasOverview: detail.skill.hasOverview,
      createdAt: detail.skill.created_at,
      source: detail.skill.source,
      sourceUrl: detail.skill.sourceUrl,
      stats: detail.skill.stats,
    },
    owner: detail.owner ?? null,
    latestVersion: detail.latestVersion
      ? {
          version: detail.latestVersion.version,
          changelog: detail.latestVersion.changelog,
          createdAt: detail.latestVersion.created_at,
        }
      : null,
    security: normalizeHubSecurity(detail.securityReports),
  };
}

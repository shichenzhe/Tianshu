/**
 * 专家市场数据模块（A2 批收编：自 src-react/domains/ai/experts/data 原位移入
 * ——前端打包的静态 TS 分片，12 分类分片聚合，无 COS 运行时链路，纯数据零
 * 依赖）。条目数据在 ./marketplace/ 分类分片中——WorkBuddy curated 专家完整
 * 复刻：元数据（名称/花名/职业/描述/标签/quickPrompts）取自其云端 manifest，
 * 正文原文照搬（含英文原文），生成时仅剥平台段（身份指令块/Final
 * Identity Reminder/内置 Skill 清单/WorkBuddy 工具表/ai-system 死引用行，
 * 品牌词替换「本平台」），规则见分片头注释。
 * 名称/描述/标签为内容数据直接中文（WorkBuddy 原文如此），不走 i18n；
 * 分类与场景标题的 i18n 与 lucide 图标映射等 UI 件留桌面消费方。
 * 桌面 src-react 原位 re-export（@tianshu/core/expert-market 子路径），
 * 桌面被控面 marketList/marketDetail 端点亦消费本模块。
 */

import { ENGINEERING_EXPERTS } from "./marketplace/expert-02-engineering";
import { PRODUCT_DESIGN_EXPERTS } from "./marketplace/expert-01-product-design";
import { GAME_SPATIAL_EXPERTS } from "./marketplace/expert-03-game-spatial";
import { DATA_AI_EXPERTS } from "./marketplace/expert-04-data-ai";
import { MARKETING_GROWTH_EXPERTS } from "./marketplace/expert-05-marketing-growth";
import { CONTENT_CREATIVE_EXPERTS } from "./marketplace/expert-06-content-creative";
import { SALES_COMMERCE_EXPERTS } from "./marketplace/expert-07-sales-commerce";
import { FINANCE_INVESTMENT_EXPERTS } from "./marketplace/expert-08-finance-investment";
import { OPERATIONS_HR_EXPERTS } from "./marketplace/expert-09-operations-hr";
import { PROJECT_QUALITY_EXPERTS } from "./marketplace/expert-10-project-quality";
import { SECURITY_COMPLIANCE_EXPERTS } from "./marketplace/expert-11-security-compliance";
import { INDUSTRY_CONSULTANT_EXPERTS } from "./marketplace/expert-12-industry-consultant";

/** 专家团成员（数据结构等价于桌面 expert-team TeamMember——成员 id 为
 *  调度引用键，systemPrompt 为成员人设；本包不依赖 electron，独立声明，
 *  桌面经结构化类型兼容消费，勿引 electron 类型入包） */
export interface ExpertMarketTeamMember {
  id: string;
  name: string;
  profession: string;
  systemPrompt: string;
}

export interface ExpertMarketItem {
  slug: string;
  name: string;
  subtitle: string;
  description: string;
  icon: string;
  systemPrompt: string;
  category: string;
  tags: string[];
  /** 推荐提示词（1-3 条，WorkBuddy quickPrompts 原文） */
  quickPrompts: string[];
  /** 附带技能名（引用已安装技能目录 slug/name，1-3 个；无对应留空数组） */
  skillNames?: string[];
  badge?: string;
  type: "expert" | "team";
  /**
   * 专家团成员（type 为 team 时必填 1-13 员；expert 条目缺省）。
   * systemPrompt 为成员人设（WorkBuddy agents/*.md 原文，含五段式结构），
   * 调度时作为成员独立上下文
   */
  members?: ExpertMarketTeamMember[];
  score: number;
  downloads: number;
  createdAt: string;
}

export interface ExpertScenario {
  slug: string;
  titleKey: string;
  icon: string;
  gradient: string;
  expertSlugs: string[];
}

export const EXPERT_CATEGORIES = [
  { key: "01-ProductDesign", labelKey: "productDesign" },
  { key: "02-Engineering", labelKey: "engineering" },
  { key: "03-GameSpatial", labelKey: "gameSpatial" },
  { key: "04-DataAI", labelKey: "dataAI" },
  { key: "05-MarketingGrowth", labelKey: "marketingGrowth" },
  { key: "06-ContentCreative", labelKey: "contentCreative" },
  { key: "07-SalesCommerce", labelKey: "salesCommerce" },
  { key: "08-FinanceInvestment", labelKey: "financeInvestment" },
  { key: "09-OperationsHR", labelKey: "operationsHR" },
  { key: "10-ProjectQuality", labelKey: "projectQuality" },
  { key: "11-SecurityCompliance", labelKey: "securityCompliance" },
  { key: "12-IndustryConsultant", labelKey: "industryConsultant" },
] as const;

export const SCENARIOS: ExpertScenario[] = [
  {
    slug: "software-dev",
    titleKey: "software-dev",
    icon: "🧑‍💻",
    gradient: "from-primary/15 to-primary-active/10",
    expertSlugs: [
      "senior-developer",
      "frontend-developer",
      "backend-architect",
      "code-review-expert",
      "software-workshop",
    ],
  },
  {
    slug: "content-creation",
    titleKey: "content-creation",
    icon: "✍️",
    gradient: "from-primary/15 to-primary-active/10",
    expertSlugs: [
      "ai-content-creator-team",
      "xiaohongshu-operations-expert",
      "wechat-official-account-expert",
      "douyin-strategist",
      "content-creator",
    ],
  },
  {
    slug: "investment",
    titleKey: "investment",
    icon: "📈",
    gradient: "from-primary/15 to-primary-active/10",
    expertSlugs: [
      "trading-agent-team",
      "stock-partner-team",
      "equity-research-expert",
      "strategy-backtest-expert",
      "fsi-market-researcher",
    ],
  },
  {
    slug: "legal",
    titleKey: "legal",
    icon: "⚖️",
    gradient: "from-primary/15 to-primary-active/10",
    expertSlugs: [
      "litigation-legal-expert",
      "contract-legal-expert",
      "legal-search-pro",
    ],
  },
  {
    slug: "business-ops",
    titleKey: "business-ops",
    icon: "🏢",
    gradient: "from-primary/15 to-primary-active/10",
    expertSlugs: [
      "software-company",
      "product-strategy-team",
      "sales-coach",
      "finance-accounting-expert",
      "china-ecommerce-operations-expert",
    ],
  },
  {
    slug: "game-dev",
    titleKey: "game-dev",
    icon: "🎮",
    gradient: "from-primary/15 to-primary-active/10",
    expertSlugs: [
      "game-development-studio",
      "game-designer",
      "godot-game-script-engineer",
    ],
  },
];

export const MARKET_EXPERTS: ExpertMarketItem[] = [
  ...PRODUCT_DESIGN_EXPERTS,
  ...ENGINEERING_EXPERTS,
  ...GAME_SPATIAL_EXPERTS,
  ...DATA_AI_EXPERTS,
  ...MARKETING_GROWTH_EXPERTS,
  ...CONTENT_CREATIVE_EXPERTS,
  ...SALES_COMMERCE_EXPERTS,
  ...FINANCE_INVESTMENT_EXPERTS,
  ...OPERATIONS_HR_EXPERTS,
  ...PROJECT_QUALITY_EXPERTS,
  ...SECURITY_COMPLIANCE_EXPERTS,
  ...INDUSTRY_CONSULTANT_EXPERTS,
];

/** 市场条目 → 建专家载荷：结构等价于桌面 AssistantCreateParams（本包不
 *  依赖 src-react，独立声明——调用方结构化类型兼容直传 AssistantApi.create
 *  与 AssistantRepository.create）。字段映射口径——profession=subtitle、
 *  categoryId=category；专家团透传 expertType/members（repo 侧 team 会话
 *  按 expertType==="team" 判别，成员为空数组时无调度目标故 team 必带） */
export interface ExpertCreateParams {
  name: string;
  icon?: string;
  systemPrompt: string;
  description?: string;
  tags?: string[];
  sourceSlug?: string;
  profession?: string;
  categoryId?: string;
  quickPrompts?: string[];
  skillNames?: string[];
  expertType?: "agent" | "team";
  members?: ExpertMarketTeamMember[];
}

export function toCreateParams(item: ExpertMarketItem): ExpertCreateParams {
  return {
    name: item.name,
    icon: item.icon,
    systemPrompt: item.systemPrompt,
    description: item.description,
    tags: item.tags,
    sourceSlug: item.slug,
    profession: item.subtitle,
    categoryId: item.category,
    quickPrompts: item.quickPrompts,
    skillNames: item.skillNames,
    ...(item.type === "team"
      ? { expertType: "team" as const, members: item.members }
      : {}),
  };
}

/** 场景引用完整性：编译期确保 expertSlugs 均存在于目录 */
const ALL_SLUGS = new Set(MARKET_EXPERTS.map((e) => e.slug));
for (const scenario of SCENARIOS) {
  for (const slug of scenario.expertSlugs) {
    if (!ALL_SLUGS.has(slug)) {
      throw new Error(`scenario ${scenario.slug} 引用了不存在的专家 ${slug}`);
    }
  }
}

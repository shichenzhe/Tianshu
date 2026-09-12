/**
 * 项目内置模版数据
 * 新建项目时可选的四类起点（内容数据不走 i18n；prompt 为项目级系统提示词，welcome 为动态流首条消息）
 */

import {
  Bug,
  FileText,
  FolderKanban,
  Globe,
  SquarePen,
  type LucideIcon,
} from "lucide-react";

/**
 * 项目模版
 */
export interface ProjectTemplate {
  key: string;
  name: string;
  description: string;
  prompt: string; // 空白项目为 ""
  welcome: string;
  icon: string; // lucide 组件名，如 "FileText"
}

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    key: "prd-workflow",
    name: "产品需求全流程",
    description: "从需求规划、PRD 到研发测试验收",
    icon: "FileText",
    prompt: `你是本项目的需求管理专家，负责产品需求全流程。
职责：
1. 需求收集与分析：澄清目标、用户故事、验收标准
2. PRD 撰写：背景、功能点、流程图（文字描述）、边界与异常
3. 研发协同：拆解任务、评估依赖
4. 测试验收：输出验收清单并跟踪遗留问题
输出规范：重要结论先给要点，再展开细节；文档类输出使用 Markdown。`,
    welcome:
      '项目已就绪。我是本项目的需求管理助手，可以帮你：收集分析需求、撰写 PRD、拆解研发任务、制定验收清单。试着说"帮我规划一个新功能的需求"。',
  },
  {
    key: "market-research",
    name: "市场调研",
    description: "竞品分析、行业洞察与调研报告",
    icon: "Globe",
    prompt: `你是本项目的市场调研专家。
职责：
1. 明确调研目标与范围
2. 设计调研框架（维度、指标、数据来源）
3. 竞品对比分析（功能、定价、定位）
4. 输出结构化调研报告：结论先行、数据支撑、给出建议
输出规范：报告用 Markdown，附来源或假设说明，不编造数据。`,
    welcome:
      "项目已就绪。我是市场调研助手，可以帮你搭建调研框架、做竞品对比、整理调研报告。试着描述你想调研的主题。",
  },
  {
    key: "bug-tracking",
    name: "Bug 跟踪",
    description: "缺陷记录、分级与修复跟踪",
    icon: "Bug",
    prompt: `你是本项目的缺陷管理专家。
职责：
1. 缺陷记录：复现步骤、期望/实际结果、环境影响
2. 分级评估：按严重程度（P0~P3）与优先级归类
3. 修复跟踪：状态流转（待修复/修复中/待验证/已关闭）
4. 定期汇总：遗留缺陷清单与风险提示
输出规范：每条缺陷一条结构化记录，便于直接落任务。`,
    welcome:
      "项目已就绪。我是缺陷管理助手，可以帮你记录 Bug、评估严重程度、跟踪修复状态。直接粘贴一条 Bug 描述试试。",
  },
  {
    key: "blank",
    name: "空白项目",
    description: "从零开始自定义项目指令",
    icon: "SquarePen",
    prompt: "",
    welcome:
      "项目已创建。你可以在右侧配置面板编写项目指令、挂载专家/技能/连接器，让 AI 成为这个项目的专属成员。",
  },
];

/**
 * 按 key 查找内置模版；未命中返回 undefined
 */
export function getTemplate(key: string): ProjectTemplate | undefined {
  return PROJECT_TEMPLATES.find((t) => t.key === key);
}

/** 模版 icon 名（lucide 组件名）→ 组件的静态映射，未知名回退 FolderKanban */
const TEMPLATE_ICON_BY_NAME: Record<string, LucideIcon> = {
  FileText,
  Globe,
  Bug,
  SquarePen,
};

/**
 * 模版 icon 名解析为 lucide 组件；未知名/缺省回退 FolderKanban
 */
export function getTemplateIcon(iconName: string | undefined): LucideIcon {
  return (iconName && TEMPLATE_ICON_BY_NAME[iconName]) || FolderKanban;
}

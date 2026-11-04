/**
 * 内置自动化模板(纯数据,spec §0:不走远端)。
 * title/desc 只放 i18n key(文案在 Task 11 的 chat.json 定义);
 * icon 为 lucide 图标名,前端 TemplateMarketView 映射组件。
 */
import type { ScheduleConfig } from "../../../../src-react/domains/ai/automation/api/schedule.schema";

export interface AutomationTemplate {
  slug: string;
  icon: string;
  titleI18nKey: string;
  descI18nKey: string;
  prompt: string;
  scheduleJson: ScheduleConfig;
  temperature: number;
}

const TEMPLATES: AutomationTemplate[] = [
  {
    slug: "daily-ai-news",
    icon: "Newspaper",
    titleI18nKey: "chat:automation.templateData.dailyAiNews.title",
    descI18nKey: "chat:automation.templateData.dailyAiNews.desc",
    prompt:
      "今天是 {{date}} 星期{{weekday}}。请汇总过去一天 AI 领域的重要动态,分「模型发布 / 工具产品 / 行业政策」三节,每条一句话 + 来源,最后给一段 50 字以内的趋势点评。",
    scheduleJson: { mode: "periodic", kind: "daily", time: "09:00" },
    temperature: 0.2,
  },
  {
    slug: "weekly-report",
    icon: "ClipboardList",
    titleI18nKey: "chat:automation.templateData.weeklyReport.title",
    descI18nKey: "chat:automation.templateData.weeklyReport.desc",
    prompt:
      "今天是 {{date}} 星期{{weekday}}。请基于本周工作空间内文件变动,生成一份周报:本周完成 / 数据指标 / 风险与阻塞 / 下周计划,Markdown 输出。",
    scheduleJson: {
      mode: "periodic",
      kind: "weekly",
      weekdays: [1],
      time: "18:00",
    },
    temperature: 0.2,
  },
  {
    slug: "biweekly-review",
    icon: "GitCompare",
    titleI18nKey: "chat:automation.templateData.biweeklyReview.title",
    descI18nKey: "chat:automation.templateData.biweeklyReview.desc",
    prompt:
      "今天是 {{date}}。请对工作空间内最近两周的代码/文档做一次双周回顾:亮点、待还的技术债、建议重构点。",
    scheduleJson: {
      mode: "periodic",
      kind: "biweekly",
      anchorDate: "2026-09-07",
      weekday: 1,
      time: "10:00",
    },
    temperature: 0.7,
  },
  {
    slug: "monthly-billing",
    icon: "Receipt",
    titleI18nKey: "chat:automation.templateData.monthlyBilling.title",
    descI18nKey: "chat:automation.templateData.monthlyBilling.desc",
    prompt:
      "今天是 {{date}}。请汇总本月模型调用账单数据,生成费用月报:分服务商统计、环比变化、异常项预警。",
    scheduleJson: {
      mode: "periodic",
      kind: "monthly",
      dayOfMonth: 1,
      time: "09:00",
    },
    temperature: 0.2,
  },
  {
    slug: "yearly-reminder",
    icon: "Sparkles",
    titleI18nKey: "chat:automation.templateData.yearlyReminder.title",
    descI18nKey: "chat:automation.templateData.yearlyReminder.desc",
    prompt:
      "今天是 {{date}}。跨年时刻,请生成本年度 AI 能力使用回顾与明年展望,轻松一点的语气。",
    scheduleJson: {
      mode: "periodic",
      kind: "yearly",
      month: 12,
      day: 31,
      time: "23:59",
    },
    temperature: 1.0,
  },
  {
    slug: "workdir-monitor",
    icon: "Radar",
    titleI18nKey: "chat:automation.templateData.workdirMonitor.title",
    descI18nKey: "chat:automation.templateData.workdirMonitor.desc",
    prompt:
      "现在是 {{time}}。请快速检查工作空间目录状态:磁盘占用 TOP5、最近修改的 10 个文件,发现异常路径立即指出。",
    scheduleJson: {
      mode: "interval",
      value: 60,
      unit: "minute",
      weekdays: [1, 2, 3, 4, 5],
    },
    temperature: 0.2,
  },
  {
    slug: "standup-prep",
    icon: "Coffee",
    titleI18nKey: "chat:automation.templateData.standupPrep.title",
    descI18nKey: "chat:automation.templateData.standupPrep.desc",
    prompt:
      "今天是 {{date}} 星期{{weekday}}。请根据昨天的工作空间产出,准备今日站会三条:昨天完成 / 今天计划 / 需要协助。",
    scheduleJson: {
      mode: "periodic",
      kind: "weekly",
      weekdays: [1, 2, 3, 4, 5],
      time: "09:30",
    },
    temperature: 0.7,
  },
];

export function listAutomationTemplates(): AutomationTemplate[] {
  return TEMPLATES.map((t) => ({ ...t, scheduleJson: { ...t.scheduleJson } }));
}

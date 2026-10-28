/**
 * 自动化埋点（自 mirror electron/domains/ai/automation/automation-stat.ts
 * 摘取，GA-T5）：仅 create 事件，detail JSON 携带
 * { mode, kind, hasEndAt, tabSwitchCount } 覆盖 PRD 三项统计。
 * 照 skill-stats 先例：fire-and-forget、吞错、delegate 缺席静默。
 * 改造点（GA-T5 登记）：commons/Log → Nest Logger（授权面 prisma/环境
 * 适配同款）。其余逐行保持。
 * T5 消费面备注：mirror 侧由 automation.repo create 通道埋点（GA-T3 摘取
 * 时按「端点面未列」舍去）；T6 automation.controller 任务创建端点接线。
 */
import { Logger } from '@nestjs/common';

const logger = new Logger('automation-stat');

export interface AutomationStatPrismaLike {
  automationStat: {
    create(args: { data: { event: string; detail: string } }): Promise<unknown>;
  };
}

export async function recordAutomationEvent(
  prisma: AutomationStatPrismaLike | undefined,
  event: 'create',
  detail: unknown,
): Promise<void> {
  if (!prisma) {
    return;
  }
  try {
    await prisma.automationStat.create({
      data: { event, detail: JSON.stringify(detail) },
    });
  } catch (e) {
    logger.warn('自动化埋点写入失败', event, e);
  }
}

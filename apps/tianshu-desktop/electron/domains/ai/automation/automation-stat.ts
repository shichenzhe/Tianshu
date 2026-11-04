/**
 * 自动化埋点(spec §5):仅 create 事件,detail JSON 携带
 * { mode, kind, hasEndAt, tabSwitchCount } 覆盖 PRD 三项统计。
 * 照 skill-stats 先例:fire-and-forget、吞错、delegate 缺席静默。
 */
import Log from "../../../commons/Log";

export interface AutomationStatPrismaLike {
  automationStat: {
    create(args: { data: { event: string; detail: string } }): Promise<unknown>;
  };
}

export async function recordAutomationEvent(
  prisma: AutomationStatPrismaLike | undefined,
  event: "create",
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
    Log.warn("自动化埋点写入失败", event, e);
  }
}

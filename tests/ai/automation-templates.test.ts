import { describe, expect, it, vi } from "vitest";
import { listAutomationTemplates } from "../../electron/domains/ai/automation/automation-templates";
import { recordAutomationEvent } from "../../electron/domains/ai/automation/automation-stat";
import { scheduleSchema } from "../../src-react/domains/ai/automation/api/schedule.schema";

// Log 以模块 mock 隔离(winston/electron 副作用不进纯函数测试,
// 同 skill-stats.test.ts 先例;真模块在 vitest 里 import 即崩)
vi.mock("../../electron/commons/Log", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

describe("内置模板", () => {
  it("至少 6 个,slug 唯一,schedule 全部通过 zod 校验", () => {
    const templates = listAutomationTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(6);
    expect(new Set(templates.map((t) => t.slug)).size).toBe(templates.length);
    for (const t of templates) {
      expect(scheduleSchema.safeParse(t.scheduleJson).success).toBe(true);
      expect(t.prompt).toContain("{{"); // 模板善用变量,保证示例性
      expect(t.titleI18nKey).toMatch(/^chat:automation\.template\./);
    }
  });
});

describe("埋点", () => {
  it("写 create 事件;prisma 缺席静默;失败吞错不抛", async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    await recordAutomationEvent(
      { automationStat: { create } } as never,
      "create",
      { mode: "periodic" },
    );
    expect(create).toHaveBeenCalledWith({
      data: { event: "create", detail: '{"mode":"periodic"}' },
    });
    await expect(
      recordAutomationEvent(undefined, "create", {}),
    ).resolves.toBeUndefined();
    const boom = vi.fn().mockRejectedValue(new Error("db down"));
    await expect(
      recordAutomationEvent(
        { automationStat: { create: boom } } as never,
        "create",
        {},
      ),
    ).resolves.toBeUndefined();
  });
});

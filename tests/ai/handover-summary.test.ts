/**
 * handover-summary 单测（三期批 12）：prompt 组装/输出清洗/空会话 +
 * 模型候选序解析 + runHandoverSummary 编排（stub ModelTextFn，
 * memory-compiler.test 同款模式——不触网不依赖真实 prisma）
 */
import { describe, expect, it, vi } from "vitest";

import {
  HANDOVER_SYSTEM_PROMPT,
  buildHandoverUserPrompt,
  runHandoverSummary,
  validateHandoverOutput,
  resolveHandoverModel,
  type HandoverPrismaLike,
} from "../../electron/domains/ai/chat/handover-summary";

const row = (role: "user" | "assistant", text: string) => ({
  role,
  blocks: JSON.stringify([{ type: "text", text }]),
});

describe("buildHandoverUserPrompt（prompt 组装）", () => {
  it("消息行拼接：用户：/助手：前缀 + text 块提取（跳过 tool/thinking 块）", () => {
    const prompt = buildHandoverUserPrompt([
      row("user", "把项目交接出去"),
      {
        role: "assistant",
        blocks: JSON.stringify([
          { type: "tool_call", toolCallId: "t1", toolName: "x", state: "done" },
          { type: "text", text: "已整理" },
        ]),
      },
    ]);
    expect(prompt).toContain("用户：把项目交接出去");
    expect(prompt).toContain("助手：已整理");
    expect(prompt).not.toContain("tool_call");
    expect(prompt).toContain("交接文档");
  });

  it("空会话/纯空块：占位「（无对话内容）」（编排层在调模型前另行报错）", () => {
    expect(buildHandoverUserPrompt([])).toContain("（无对话内容）");
    expect(
      buildHandoverUserPrompt([
        {
          role: "user",
          blocks: JSON.stringify([{ type: "thinking", text: "…" }]),
        },
      ]),
    ).toContain("（无对话内容）");
  });

  it("超长截断保尾部最新（30000 字符上限，整行丢弃最旧）", () => {
    const rows = [
      row("user", "旧消息"),
      row("assistant", "中".repeat(30010)),
      row("user", "最新结论"),
    ];
    const prompt = buildHandoverUserPrompt(rows);
    expect(prompt).not.toContain("旧消息");
    expect(prompt).toContain("最新结论");
    expect(prompt.length).toBeLessThan(31000);
  });
});

describe("validateHandoverOutput（输出清洗）", () => {
  it("剥代码围栏 + 首尾空白", () => {
    expect(validateHandoverOutput("```markdown\n## 工作目标\n接管\n```")).toBe(
      "## 工作目标\n接管",
    );
    expect(validateHandoverOutput("  ## 当前状态  \n")).toBe("## 当前状态");
  });

  it("空输出（含纯围栏/纯空白）→ null", () => {
    expect(validateHandoverOutput("")).toBeNull();
    expect(validateHandoverOutput("   \n")).toBeNull();
    expect(validateHandoverOutput("```\n```")).toBeNull();
  });
});

describe("resolveHandoverModel（候选序）", () => {
  const provider = (enabled = true) => ({
    type: "openai-compatible",
    baseUrl: "https://x",
    apiKey: null,
    extraHeaders: null,
    enabled,
  });
  const makePrisma = (
    models: Array<{
      id: number;
      providerId: number;
      modelId: string;
      enabled: boolean;
    }>,
    providers: Record<number, ReturnType<typeof provider> | null>,
    defaults: Array<number | null> = [],
  ): HandoverPrismaLike => ({
    workspace: {
      findMany: vi.fn(async () =>
        defaults.map((defaultModelId) => ({ defaultModelId })),
      ),
    },
    model: { findMany: vi.fn(async () => models) },
    provider: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: number } }) =>
          providers[where.id] ?? null,
      ),
    },
    message: { findMany: vi.fn(async () => []) },
  });

  it("会话当前模型优先（命中即用）", async () => {
    const prismaLike = makePrisma(
      [
        { id: 7, providerId: 3, modelId: "session-model", enabled: true },
        { id: 9, providerId: 3, modelId: "default-model", enabled: true },
      ],
      { 3: provider() },
    );
    await expect(resolveHandoverModel(prismaLike, 7)).resolves.toMatchObject({
      modelId: "session-model",
    });
  });

  it("当前模型禁用 → 回落空间默认；服务商禁用跳过继续候选", async () => {
    const prismaLike = makePrisma(
      [
        { id: 7, providerId: 3, modelId: "session-model", enabled: false },
        { id: 8, providerId: 4, modelId: "default-model", enabled: true },
        { id: 9, providerId: 5, modelId: "any-model", enabled: true },
      ],
      { 4: provider(false), 5: provider() },
      [8],
    );
    await expect(resolveHandoverModel(prismaLike, 7)).resolves.toMatchObject({
      modelId: "any-model",
    });
  });

  it("无可用模型（空启用集/服务商全禁）→ null", async () => {
    await expect(
      resolveHandoverModel(makePrisma([], {}), 7),
    ).resolves.toBeNull();
  });
});

describe("runHandoverSummary（编排）", () => {
  const rows = [row("user", "交接内容"), row("assistant", "好的")];
  const model = { id: 7, providerId: 3, modelId: "m", enabled: true };
  const makePrisma = (messages: unknown[]): HandoverPrismaLike => ({
    workspace: { findMany: vi.fn(async () => []) },
    model: { findMany: vi.fn(async () => [model]) },
    provider: {
      findUnique: vi.fn(async () => ({
        type: "openai-compatible",
        baseUrl: "https://x",
        enabled: true,
      })),
    },
    message: { findMany: vi.fn(async () => messages) },
  });

  it("正常：system 为五段指令、prompt 含材料，返回清洗后 markdown", async () => {
    const modelText = vi.fn(async () => "## 工作目标\n接管");
    const result = await runHandoverSummary({
      prismaLike: makePrisma(rows),
      sessionId: 1,
      currentModelId: 7,
      modelText,
    });
    const [system, prompt] = modelText.mock.calls[0];
    expect(system).toBe(HANDOVER_SYSTEM_PROMPT);
    expect(system).toContain("已做出的决策可放心沿用");
    expect(prompt).toContain("用户：交接内容");
    expect(result).toBe("## 工作目标\n接管");
  });

  it("无消息：明确中文报错，不调模型", async () => {
    const modelText = vi.fn();
    await expect(
      runHandoverSummary({
        prismaLike: makePrisma([]),
        sessionId: 1,
        currentModelId: 7,
        modelText,
      }),
    ).rejects.toThrow("会话暂无消息");
    expect(modelText).not.toHaveBeenCalled();
  });

  it("无可用模型：明确中文报错", async () => {
    const prismaLike = makePrisma(rows);
    (prismaLike.model.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
      [],
    );
    await expect(
      runHandoverSummary({
        prismaLike,
        sessionId: 1,
        currentModelId: 7,
        modelText: vi.fn(),
      }),
    ).rejects.toThrow("未配置可用模型");
  });

  it("模型输出为空：报 HANDOVER 空输出错误；模型抛错原样上抛", async () => {
    await expect(
      runHandoverSummary({
        prismaLike: makePrisma(rows),
        sessionId: 1,
        currentModelId: 7,
        modelText: vi.fn(async () => "  \n"),
      }),
    ).rejects.toThrow("交接摘要生成失败");
    await expect(
      runHandoverSummary({
        prismaLike: makePrisma(rows),
        sessionId: 1,
        currentModelId: 7,
        modelText: vi.fn(async () => {
          throw new Error("NETWORK");
        }),
      }),
    ).rejects.toThrow("NETWORK");
  });
});

/**
 * 记忆 AI 管线单测：prompt 构建 / 输出校验 / 近期对话提取
 * （含归档会话两步过滤）/ 模型解析候选序 / compileMemory 注入调用
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  // Log/prisma-client 顶层读取 app.getPath("userData")/getAppPath/isPackaged
  // 计算日志与数据目录（data-root 冷迁移链路）
  app: {
    getPath: vi.fn(() => `/tmp/tianshu-test-user-data-${process.pid}`),
    getAppPath: vi.fn(() => `/tmp/tianshu-test-app-${process.pid}`),
    isPackaged: false,
  },
}));

// resolveMemoryModel 经全局 prisma 查 workspace.defaultModelId 与
// option.memoryModelId（强指定），屏蔽 prisma-client 模块初始化对
// electron app 路径的依赖（既有模式）
vi.mock("../../electron/commons/prisma-client", () => ({
  default: {
    workspace: {
      findMany: (...args: unknown[]) => workspaceStub.findMany(...args),
    },
    option: {
      findMany: (...args: unknown[]) => optionStub.findMany(...args),
    },
  },
}));

const workspaceStub = { findMany: vi.fn() };
const optionStub = { findMany: vi.fn() };

// 默认补全走 LangChain（T1-4）：mock 模型工厂直测默认 modelText 行为
// （tests/ 不在 tsconfig include 内，类型断言无 tsc 覆盖，R1 行为级验证，
// handover-summary.test 同款模式）
vi.mock(
  "../../electron/domains/ai/orchestration/langchain-model-factory",
  () => ({ createChatModel: vi.fn() }),
);

import { HumanMessage, SystemMessage } from "@langchain/core/messages";

import { createChatModel } from "../../electron/domains/ai/orchestration/langchain-model-factory";
import {
  MEMORY_COMPILER_SYSTEM_PROMPT,
  buildCompileUserPrompt,
  buildInstructionUserPrompt,
  compileMemory,
  fetchRecentConversation,
  resolveMemoryModel,
  validateMemoryOutput,
} from "../../electron/domains/ai/personalization/memory-compiler";
import type { MemoryModelContext } from "../../electron/domains/ai/personalization/memory-compiler";

describe("prompt 构建", () => {
  it("系统提示词含四标题与硬性约束（画像式提炼，修订 2026-09-10 去流水账）", () => {
    for (const title of ["工作背景", "个人背景", "当前关注", "近期动态"]) {
      expect(MEMORY_COMPILER_SYSTEM_PROMPT).toContain(title);
    }
    expect(MEMORY_COMPILER_SYSTEM_PROMPT).toContain("只输出");
    // 新验收反馈核心条款：画像式提炼 + 各节条数上限 8/8/5/10 + 淘汰一次性内容
    expect(MEMORY_COMPILER_SYSTEM_PROMPT).toContain("画像式而非流水账");
    expect(MEMORY_COMPILER_SYSTEM_PROMPT).toContain("工作背景 ≤8 条");
    expect(MEMORY_COMPILER_SYSTEM_PROMPT).toContain("个人背景 ≤8 条");
    expect(MEMORY_COMPILER_SYSTEM_PROMPT).toContain("当前关注 ≤5 条");
    expect(MEMORY_COMPILER_SYSTEM_PROMPT).toContain("近期动态 ≤10 条");
  });
  it("次级模型防污染条款（修订 2026-10-23）：来源限定 + 准入判据 + 负面清单 + 判断示例", () => {
    // 素材来源限定：画像只从用户内容提炼（材料里助手输出占大头）
    expect(MEMORY_COMPILER_SYSTEM_PROMPT).toContain(
      "只从「用户：」开头的内容提炼",
    );
    expect(MEMORY_COMPILER_SYSTEM_PROMPT).toContain("一律不进画像");
    // 准入二判据 + 精度优先
    expect(MEMORY_COMPILER_SYSTEM_PROMPT).toContain("能改变后续对话的回应方式");
    expect(MEMORY_COMPILER_SYSTEM_PROMPT).toContain("半年后仍有参考价值");
    expect(MEMORY_COMPILER_SYSTEM_PROMPT).toContain("存疑时直接丢弃");
    // 负面清单核心项 + 判断示例（弱模型反例遵循）
    expect(MEMORY_COMPILER_SYSTEM_PROMPT).toContain("【永不写入】");
    expect(MEMORY_COMPILER_SYSTEM_PROMPT).toContain("用户粘贴的材料本身");
    expect(MEMORY_COMPILER_SYSTEM_PROMPT).toContain("【判断示例】");
    expect(MEMORY_COMPILER_SYSTEM_PROMPT).toContain("临时调试");
    // 单条上限收紧：一条一个事实（500 → 100）
    expect(MEMORY_COMPILER_SYSTEM_PROMPT).toContain("一条一个独立事实");
    expect(MEMORY_COMPILER_SYSTEM_PROMPT).toContain("单条 ≤100 字");
    expect(MEMORY_COMPILER_SYSTEM_PROMPT).not.toContain("单条 ≤500 字");
  });
  it("判断层防污染条款（修订 2026-10-23b 实测回评）：频率禁令 + 技能判据 + 当前关注收紧 + 去重", () => {
    // 频率词禁令：单次行为不得推断「日常/习惯」（实测「问过天气→日常关注天气」脑补）
    expect(MEMORY_COMPILER_SYSTEM_PROMPT).toContain("禁止从单次行为推断");
    expect(MEMORY_COMPILER_SYSTEM_PROMPT).toContain("问过一次天气");
    // 技能领域判据：长期反复，单次任务用过的工具不算
    expect(MEMORY_COMPILER_SYSTEM_PROMPT).toContain(
      "单次任务中用过的工具、知识不算技能领域",
    );
    // 当前关注收紧：跨多天仍在推进；当天已解决不得进任何节
    expect(MEMORY_COMPILER_SYSTEM_PROMPT).toContain("跨多天仍在推进");
    expect(MEMORY_COMPILER_SYSTEM_PROMPT).toContain("当天已解决的问题");
    // 操作细节禁区（实测错误码/测试账号入条）
    expect(MEMORY_COMPILER_SYSTEM_PROMPT).toContain("错误码、测试账号名");
    // 同一事件只记一处（实测当前关注与近期动态重复记同一工作流）
    expect(MEMORY_COMPILER_SYSTEM_PROMPT).toContain("同一事件只记一处");
  });
  it("整理 prompt 含当前记忆与材料", () => {
    const p = buildCompileUserPrompt("当前记忆", "对话材料");
    expect(p).toContain("当前记忆");
    expect(p).toContain("对话材料");
  });
  it("指令 prompt 含当前记忆与用户指令", () => {
    const p = buildInstructionUserPrompt("当前记忆", "删掉天气");
    expect(p).toContain("当前记忆");
    expect(p).toContain("删掉天气");
  });
  it("当前记忆为空时以（空）占位", () => {
    expect(buildCompileUserPrompt("", "材料")).toContain("（空）");
    expect(buildInstructionUserPrompt("", "指令")).toContain("（空）");
  });
});

/** 四标题齐备的合法输出（I2：四节标题缺一不可） */
const FULL_MD =
  "## 工作背景\na\n\n## 个人背景\nb\n\n## 当前关注\nc\n\n## 近期动态\nd";

describe("validateMemoryOutput", () => {
  it("四标题齐备：剥围栏 + 归一化后返回（标准输入幂等）", () => {
    const raw = "```\n" + FULL_MD + "\n```";
    expect(validateMemoryOutput(raw)).toBe(FULL_MD);
  });
  it("无任何已知标题 → 全进工作背景节（二次放宽：小模型输出也生效）", () => {
    expect(validateMemoryOutput("我无法完成这个任务")).toBe(
      "## 工作背景\n我无法完成这个任务",
    );
    expect(validateMemoryOutput("")).toBeNull();
  });
  it("缺节 → 归一化保留已有节（I2 放宽：模型省略空节不再整轮作废）", () => {
    expect(validateMemoryOutput("## 工作背景\nabc")).toBe("## 工作背景\nabc");
    expect(validateMemoryOutput("## 工作背景\na\n## 当前关注\nc")).toBe(
      "## 工作背景\na\n\n## 当前关注\nc",
    );
  });
  it("节序乱 → 归一化按固定节序重排", () => {
    expect(validateMemoryOutput("## 近期动态\nd\n## 工作背景\na")).toBe(
      "## 工作背景\na\n\n## 近期动态\nd",
    );
  });
  it("标题变体（**加粗**/说明后缀/三级标题/无空格）归一为标准标题行", () => {
    expect(validateMemoryOutput("## **工作背景**\na")).toBe("## 工作背景\na");
    expect(validateMemoryOutput("### 工作背景 —— 职业与项目\nd")).toBe(
      "## 工作背景\nd",
    );
    expect(validateMemoryOutput("##近期动态\nd")).toBe("## 近期动态\nd");
    expect(validateMemoryOutput("## _个人背景_\nb")).toBe("## 个人背景\nb");
  });
  it("标题词延续不识别为标题：「工作背景补充」整段进工作背景节", () => {
    expect(validateMemoryOutput("## 工作背景补充\n内容")).toBe(
      "## 工作背景\n## 工作背景补充\n内容",
    );
  });
  it("超 MEMORY_PROFILE_LIMIT 从头部截断", () => {
    const raw = `## 工作背景\n${"旧".repeat(9000)}\n## 个人背景\nb\n## 当前关注\nc\n## 近期动态\n新`;
    const validated = validateMemoryOutput(raw);
    expect(validated?.length).toBe(8000);
    expect(validated?.endsWith("## 近期动态\n新")).toBe(true);
  });
});

describe("fetchRecentConversation", () => {
  const mkRow = (id: number, role: string, text: string) => ({
    id,
    role,
    blocks: JSON.stringify([{ type: "text", text }]),
  });
  it("拼接 用户/助手 前缀，跳过空文本与非文本块", async () => {
    // 查询倒序取回（orderBy id desc），mock 按新契约排列
    const prismaLike = {
      message: {
        findMany: async () => [
          mkRow(3, "assistant", "在的"),
          {
            id: 2,
            role: "assistant",
            blocks: JSON.stringify([{ type: "usage", input: 1, output: 2 }]),
          },
          mkRow(1, "user", "你好"),
        ],
      },
    };
    const text = await fetchRecentConversation(prismaLike as never, 7, 30000);
    expect(text).toBe("用户：你好\n助手：在的");
  });
  it("超 charLimit 保最新（丢弃最旧）", async () => {
    const rows = [
      mkRow(2, "user", "新内容"),
      mkRow(1, "user", "旧".repeat(100)),
    ];
    const prismaLike = { message: { findMany: async () => rows } };
    const text = await fetchRecentConversation(prismaLike as never, 7, 10);
    expect(text).toContain("新内容");
    expect(text).not.toContain("旧");
  });
  it("无消息返回空串", async () => {
    const prismaLike = { message: { findMany: async () => [] } };
    expect(await fetchRecentConversation(prismaLike as never, 7, 30000)).toBe(
      "",
    );
  });
  it("倒序限量取最新消息再翻转回时间正序（select 只取 role/blocks）", async () => {
    // M2 性能回归：keepRecentLines 只保尾部 charLimit 字符，近 7 天全量
    // 读回（含大 blocks）对长用户可达数十 MB，属纯白搬（见性能审查报告）
    const findMany = vi.fn(async () => [
      mkRow(3, "assistant", "在的"),
      mkRow(1, "user", "你好"),
    ]);
    const prismaLike = { message: { findMany } };
    const text = await fetchRecentConversation(prismaLike as never, 7, 30000);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { id: "desc" },
        take: 500,
        select: { role: true, blocks: true },
      }),
    );
    // 倒序取回后须翻转回时间正序再拼接（保尾部语义不变）
    expect(text).toBe("用户：你好\n助手：在的");
  });
  it("提供 session delegate 时按未归档会话过滤（schema 无关系、两步查询）", async () => {
    const findMany = vi.fn(async () => [mkRow(1, "user", "你好")]);
    const prismaLike = {
      message: { findMany },
      session: { findMany: async () => [{ id: 5 }, { id: 7 }] },
    };
    const text = await fetchRecentConversation(prismaLike as never, 7, 30000);
    expect(text).toBe("用户：你好");
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ sessionId: { in: [5, 7] } }),
      }),
    );
  });
  it("会话过滤排除项目会话（projectId: null，项目动态流不进全局记忆）", async () => {
    const sessionFindMany = vi.fn(async () => [{ id: 5 }]);
    const prismaLike = {
      message: { findMany: async () => [mkRow(1, "user", "你好")] },
      session: { findMany: sessionFindMany },
    };
    await fetchRecentConversation(prismaLike as never, 7, 30000);
    expect(sessionFindMany).toHaveBeenCalledWith({
      where: { archivedAt: null, projectId: null },
      select: { id: true },
    });
  });
});

describe("resolveMemoryModel", () => {
  const providerInfo = {
    type: "openai-compatible",
    baseUrl: "http://localhost",
    apiKey: "k",
  };
  beforeEach(() => {
    workspaceStub.findMany.mockReset();
    optionStub.findMany.mockReset();
    optionStub.findMany.mockResolvedValue([]); // 无强指定（默认态）
  });
  it("设置页强指定 memoryModelId 优先于 workspace 默认", async () => {
    optionStub.findMany.mockResolvedValue([
      { name: "personalization.memoryModelId", value: "7" },
    ]);
    workspaceStub.findMany.mockResolvedValue([{ defaultModelId: 2 }]);
    const getById = vi.fn(async (id: number) => ({
      id,
      providerId: 8,
      modelId: `m${id}`,
      enabled: true,
    }));
    const ctx = await resolveMemoryModel(
      { getRuntimeInfo: async () => providerInfo },
      { getById },
      async () => [],
    );
    expect(ctx?.modelId).toBe("m7");
    expect(getById).toHaveBeenNthCalledWith(1, 7);
  });
  it("强指定模型禁用 → 回退 workspace 默认（候选序自然回退）", async () => {
    optionStub.findMany.mockResolvedValue([
      { name: "personalization.memoryModelId", value: "7" },
    ]);
    workspaceStub.findMany.mockResolvedValue([{ defaultModelId: 2 }]);
    const getById = vi.fn(async (id: number) => ({
      id,
      providerId: 8,
      modelId: `m${id}`,
      enabled: id === 7 ? false : true,
    }));
    const ctx = await resolveMemoryModel(
      { getRuntimeInfo: async () => providerInfo },
      { getById },
      async () => [],
    );
    expect(ctx?.modelId).toBe("m2");
  });
  it("workspace 默认模型优先（须存在且启用）", async () => {
    workspaceStub.findMany.mockResolvedValue([{ defaultModelId: 2 }]);
    const getById = vi.fn(async (id: number) =>
      id === 2
        ? { id: 2, providerId: 9, modelId: "default-model", enabled: true }
        : { id, providerId: 8, modelId: "other", enabled: true },
    );
    const ctx = await resolveMemoryModel(
      { getRuntimeInfo: async () => providerInfo },
      { getById },
      async () => [{ id: 1, providerId: 8, modelId: "other", enabled: true }],
    );
    expect(ctx).toEqual({ ...providerInfo, modelId: "default-model" });
    expect(getById).toHaveBeenCalledWith(2);
    // P2 遍历面核查：默认模型候选不遍历项目资产空间（projectId 非空）
    expect(workspaceStub.findMany).toHaveBeenCalledWith({
      where: { projectId: null },
      orderBy: { id: "asc" },
      select: { defaultModelId: true },
    });
  });
  it("默认模型缺失/禁用 → 回退任意启用模型；全部不可用 → null", async () => {
    workspaceStub.findMany.mockResolvedValue([{ defaultModelId: 2 }]);
    const disabled = { id: 2, providerId: 9, modelId: "off", enabled: false };
    const enabled = { id: 1, providerId: 8, modelId: "on", enabled: true };
    const ctx = await resolveMemoryModel(
      { getRuntimeInfo: async () => providerInfo },
      { getById: async (id: number) => (id === 1 ? enabled : disabled) },
      async () => [enabled, disabled],
    );
    expect(ctx).toEqual({ ...providerInfo, modelId: "on" });
    const none = await resolveMemoryModel(
      { getRuntimeInfo: async () => null },
      { getById: async () => null },
      async () => [],
    );
    expect(none).toBeNull();
  });
});

describe("compileMemory", () => {
  const model: MemoryModelContext = {
    type: "openai-compatible",
    baseUrl: "http://localhost",
    modelId: "m1",
  };
  it("整理模式：走对话材料 prompt，返回校验后的新记忆", async () => {
    const output =
      "## 工作背景\n[2026-09-09] - 新条目\n\n## 个人背景\nb\n\n## 当前关注\nc\n\n## 近期动态\nd";
    const modelText = vi.fn(async () => output);
    const memory = await compileMemory({
      currentMemory: "",
      material: "对话材料",
      instructionMode: false,
      model,
      modelText,
    });
    expect(memory).toBe(output);
    expect(modelText).toHaveBeenCalledTimes(1);
    const [system, prompt] = modelText.mock.calls[0];
    expect(system).toBe(MEMORY_COMPILER_SYSTEM_PROMPT);
    // 头部注入时间行（条目 [YYYY-MM-DD]/倒序/过时判断的「今天」基准）
    expect(prompt).toMatch(
      /^当前时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2} 周[日一二三四五六] UTC[+-]\d{2}:\d{2}\n\n/,
    );
    expect(prompt).toContain("（空）");
    expect(prompt).toContain("近期对话材料");
    expect(prompt).toContain("对话材料");
  });
  it("指令模式：走用户指令 prompt", async () => {
    const modelText = vi.fn(async () => FULL_MD);
    await compileMemory({
      currentMemory: "当前记忆",
      material: "删掉天气",
      instructionMode: true,
      model,
      modelText,
    });
    expect(modelText.mock.calls[0][1]).toContain("用户指令");
    expect(modelText.mock.calls[0][1]).toContain("删掉天气");
  });
  it("输出无任何标题 → 全进工作背景节（二次放宽，不再抛错）", async () => {
    const memory = await compileMemory({
      currentMemory: "",
      material: "材料",
      instructionMode: false,
      model,
      modelText: async () => "无法完成",
    });
    expect(memory).toBe("## 工作背景\n无法完成");
  });
  it("输出为空串 → 抛 MEMORY_COMPILE_FAILED（唯一拒绝形态）", async () => {
    await expect(
      compileMemory({
        currentMemory: "",
        material: "材料",
        instructionMode: false,
        model,
        modelText: async () => "",
      }),
    ).rejects.toThrow("MEMORY_COMPILE_FAILED");
  });
  it("输出只含部分四节标题 → 归一化保留（I2 放宽，不再抛错）", async () => {
    const memory = await compileMemory({
      currentMemory: "",
      material: "材料",
      instructionMode: false,
      model,
      modelText: async () => "## 工作背景\n只有一节",
    });
    expect(memory).toBe("## 工作背景\n只有一节");
  });
  it("默认补全（不传 modelText）：invoke 消息序 + signal 透传（T1-4）", async () => {
    const fakeInvoke = vi.fn(async () => ({
      content: "## 工作背景\n[2026-09-09] - 新条目",
    }));
    vi.mocked(createChatModel).mockReturnValue({
      invoke: fakeInvoke,
    } as unknown as ReturnType<typeof createChatModel>);
    const controller = new AbortController();
    const memory = await compileMemory({
      currentMemory: "",
      material: "对话材料",
      instructionMode: false,
      model,
      signal: controller.signal,
    });
    expect(createChatModel).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "openai-compatible",
        baseUrl: "http://localhost",
        modelId: "m1",
      }),
      "m1",
    );
    const [messages, options] = fakeInvoke.mock.calls[0] as unknown as [
      unknown[],
      { signal?: AbortSignal } | undefined,
    ];
    expect(messages).toHaveLength(2);
    expect(messages[0]).toBeInstanceOf(SystemMessage);
    expect((messages[0] as SystemMessage).content).toBe(
      MEMORY_COMPILER_SYSTEM_PROMPT,
    );
    expect(messages[1]).toBeInstanceOf(HumanMessage);
    expect((messages[1] as HumanMessage).content).toContain("对话材料");
    // ModelTextFn 第三参 signal 必须透传到 chat.invoke（调用方可取消）
    expect(options?.signal).toBe(controller.signal);
    expect(memory).toBe("## 工作背景\n[2026-09-09] - 新条目");
  });
});

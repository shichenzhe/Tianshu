/**
 * search_history 内置工具单测（spec 2026-11-02-history-search-tool-design）：
 * 片段提取纯函数（多块型命中/超长窗口/args 命中兜底/坏 JSON）+ 结果格式化
 * （同会话聚合/组间最新优先/limit 截断/空文案）+ execute 查询组装
 * （userId 过滤/当前会话排除/take 上限）——依赖注入 fake prisma
 * （makePlanTools({ prisma }) 先例），零 vi.mock
 */
import { describe, expect, it } from "vitest";
import {
  HISTORY_SEARCH_EMPTY,
  HISTORY_SEARCH_TOOL_NAME,
  MESSAGE_SCAN_LIMIT,
  extractSnippet,
  formatHistorySearchResults,
  makeHistorySearchTool,
  type HistorySearchPrisma,
} from "../../electron/domains/ai/agent/history-search-tool";
import type { ToolContext } from "../../electron/domains/ai/agent/file-tools";

/** 便捷造 blocks JSON（text 块） */
const textBlocks = (text: string) => JSON.stringify([{ type: "text", text }]);

/** tool_call 块（协议必备字段 toolCallId/toolName，output string 形态） */
const toolBlocks = (output: string, args?: unknown) =>
  JSON.stringify([
    { type: "tool_call", toolCallId: "tc1", toolName: "fake", args, output },
  ]);

const CTX = (over: Partial<ToolContext> = {}): ToolContext => ({
  workspacePath: "/tmp/ws",
  sessionId: 7,
  userId: 1,
  ...over,
});

/** fake prisma：捕获调用参数 + 可编排返回 */
function makeFakePrisma(
  sessions: Array<{ id: number; title: string | null }>,
  messages: Array<{ sessionId: number; blocks: string; createdAt: Date }>,
) {
  const calls = {
    session: null as unknown,
    message: null as unknown,
  };
  const prisma: HistorySearchPrisma = {
    session: {
      findMany: async (args: unknown) => {
        calls.session = args;
        return sessions;
      },
    },
    message: {
      findMany: async (args: unknown) => {
        calls.message = args;
        return messages;
      },
    },
  };
  return { prisma, calls };
}

describe("search_history 元信息", () => {
  it("name/description/kind 符合规范，description 含检索路由指引", () => {
    const tool = makeHistorySearchTool(makeFakePrisma([], []).prisma);
    expect(tool.name).toBe(HISTORY_SEARCH_TOOL_NAME);
    expect(tool.kind).toBe("read");
    // WB 逆向吸收的路由分层三要素：自包含查询/已有不查/排除当前会话
    expect(tool.description).toContain("不含本会话");
    expect(tool.description).toContain("自包含");
    expect(tool.description).toContain("不要调用");
  });
});

describe("search_history execute 查询组装", () => {
  it("session 查询按 userId 过滤；message 查询 blocks contains + 排除当前会话 + 最新优先 + take 上限", async () => {
    const { prisma, calls } = makeFakePrisma(
      [
        { id: 7, title: "当前会话" },
        { id: 8, title: "旧会话" },
      ],
      [],
    );
    const tool = makeHistorySearchTool(prisma);
    await tool.execute(CTX(), { query: "部署方案" });
    expect(calls.session).toEqual({
      where: { userId: 1 },
      select: { id: true, title: true },
    });
    expect(calls.message).toEqual({
      where: {
        blocks: { contains: "部署方案" },
        sessionId: { in: [8] },
      },
      orderBy: { createdAt: "desc" },
      take: MESSAGE_SCAN_LIMIT,
    });
  });

  it("userId 取 ctx（隔离面）；sessionId null（图执行）不排除任何会话", async () => {
    const { prisma, calls } = makeFakePrisma(
      [
        { id: 1, title: "a" },
        { id: 2, title: "b" },
      ],
      [],
    );
    const tool = makeHistorySearchTool(prisma);
    await tool.execute(CTX({ userId: 3, sessionId: null }), { query: "q" });
    expect(calls.session).toEqual({
      where: { userId: 3 },
      select: { id: true, title: true },
    });
    expect(
      (calls.message as { where: { sessionId: { in: number[] } } }).where
        .sessionId.in,
    ).toEqual([1, 2]);
  });

  it("query trim 后为空直接返回空文案，不触 message 查询", async () => {
    const { prisma, calls } = makeFakePrisma([{ id: 1, title: "a" }], []);
    const tool = makeHistorySearchTool(prisma);
    await expect(tool.execute(CTX(), { query: "   " })).resolves.toBe(
      HISTORY_SEARCH_EMPTY,
    );
    expect(calls.message).toBeNull();
  });

  it("query 超长截 100 字符（防超长 LIKE）", async () => {
    const { prisma, calls } = makeFakePrisma([{ id: 1, title: "a" }], []);
    const tool = makeHistorySearchTool(prisma);
    const long = "x".repeat(150);
    await tool.execute(CTX(), { query: long });
    expect(
      (calls.message as { where: { blocks: { contains: string } } }).where
        .blocks.contains,
    ).toBe("x".repeat(100));
  });

  it("未命中返回空文案（含改写建议）", async () => {
    const { prisma } = makeFakePrisma([{ id: 8, title: "旧" }], []);
    const tool = makeHistorySearchTool(prisma);
    await expect(tool.execute(CTX(), { query: "不存在的内容" })).resolves.toBe(
      HISTORY_SEARCH_EMPTY,
    );
    expect(HISTORY_SEARCH_EMPTY).toContain("时间范围");
  });
});

describe("search_history execute 结果格式化", () => {
  const D = (s: string) => new Date(s);

  it("同会话多消息聚合一行、组间最新优先、片段上限 3", async () => {
    const { prisma } = makeFakePrisma(
      [
        { id: 8, title: "部署讨论" },
        { id: 9, title: "更晚的排错" },
      ],
      [
        // createdAt desc 序（findMany 返回序）：会话 9 最新在前
        {
          sessionId: 9,
          blocks: textBlocks("端口占用是根因"),
          createdAt: D("2026-11-02"),
        },
        {
          sessionId: 8,
          blocks: textBlocks("部署方案定了用 docker"),
          createdAt: D("2026-10-31"),
        },
        {
          sessionId: 8,
          blocks: textBlocks("部署方案评审通过"),
          createdAt: D("2026-10-30"),
        },
        {
          sessionId: 8,
          blocks: textBlocks("部署方案初稿"),
          createdAt: D("2026-10-29"),
        },
        {
          sessionId: 8,
          blocks: textBlocks("第四条不再进片段"),
          createdAt: D("2026-10-28"),
        },
      ],
    );
    const tool = makeHistorySearchTool(prisma);
    const out = await tool.execute(CTX(), { query: "部署方案" });
    const lines = out.split("\n");
    expect(lines[0]).toBe("历史会话命中 2 个：");
    expect(lines[1]).toBe("- 更晚的排错（2026-11-02）：端口占用是根因");
    expect(lines[2]).toContain("部署讨论（2026-10-31）：");
    // 三片段拼接、第四条不出现
    expect(lines[2]).toContain("初稿");
    expect(lines[2]).not.toContain("第四条");
  });

  it("limit 截断组数（缺省 5，上限 10 由 zod 校验）", async () => {
    const sessions = [1, 2, 3].map((id) => ({ id, title: `s${id}` }));
    const messages = [1, 2, 3].map((id) => ({
      sessionId: id,
      blocks: textBlocks(`目标内容在会话${id}`),
      createdAt: D(`2026-10-0${id}`),
    }));
    const { prisma } = makeFakePrisma(sessions, messages);
    const tool = makeHistorySearchTool(prisma);
    const out = await tool.execute(CTX(), { query: "目标内容", limit: 2 });
    expect(out).toContain("历史会话命中 2 个：");
    expect(out).not.toContain("会话3");
  });

  it("无可读片段的消息（纯 image 组）整组剔除，不计入命中数", async () => {
    const { prisma } = makeFakePrisma(
      [
        { id: 8, title: "图会话" },
        { id: 9, title: "文会话" },
      ],
      [
        {
          sessionId: 8,
          blocks: JSON.stringify([
            { type: "image", imagePath: "a.png", mime: "image/png" },
          ]),
          createdAt: D("2026-11-01"),
        },
        {
          sessionId: 9,
          blocks: textBlocks("这里有目标"),
          createdAt: D("2026-10-31"),
        },
      ],
    );
    const tool = makeHistorySearchTool(prisma);
    const out = await tool.execute(CTX(), { query: "目标" });
    // image 组：blocks LIKE 可能经 path 命中，但无片段 → 剔除
    expect(out).toBe("历史会话命中 1 个：\n- 文会话（2026-10-31）：这里有目标");
  });

  it("title null 的旧会话行回退未命名会话", async () => {
    const { prisma } = makeFakePrisma(
      [{ id: 8, title: null }],
      [
        {
          sessionId: 8,
          blocks: textBlocks("目标"),
          createdAt: D("2026-10-01"),
        },
      ],
    );
    const tool = makeHistorySearchTool(prisma);
    await expect(tool.execute(CTX(), { query: "目标" })).resolves.toContain(
      "未命名会话（2026-10-01）",
    );
  });
});

describe("extractSnippet 片段提取纯函数", () => {
  it("短文本整体为片段（换行压平）", () => {
    expect(extractSnippet(textBlocks("第一行\n第二行含目标词"), "目标词")).toBe(
      "第一行 第二行含目标词",
    );
  });

  it("长文本以命中位置为中心取窗口并加省略号，长度 ≤300", () => {
    const filler = "甲".repeat(500);
    const text = `${filler}目标词${filler}`;
    const snippet = extractSnippet(textBlocks(text), "目标词");
    expect(snippet).not.toBeNull();
    expect(snippet!.length).toBeLessThanOrEqual(302); // 300 + 两侧省略号
    expect(snippet!.startsWith("…")).toBe(true);
    expect(snippet!.endsWith("…")).toBe(true);
    expect(snippet!).toContain("目标词");
  });

  it("英文大小写不敏感命中", () => {
    expect(
      extractSnippet(textBlocks("we used Docker Compose here"), "docker"),
    ).toBe("we used Docker Compose here");
  });

  it("text 无命中时回退 tool_call output 命中窗口", () => {
    const snippet = extractSnippet(
      JSON.stringify([
        { type: "text", text: "看看工具结果" },
        {
          type: "tool_call",
          toolCallId: "tc2",
          toolName: "bash",
          args: { cmd: "ls" },
          output: "目标输出很长".repeat(80),
        },
      ]),
      "目标输出",
    );
    expect(snippet).toContain("目标输出");
    expect(snippet!.length).toBeLessThanOrEqual(302);
  });

  it("仅 args 命中（可读源无 query）时取第一个非空可读源头部", () => {
    const snippet = extractSnippet(
      toolBlocks("工具输出正文与关键词无关", { target: "唯一关键词" }),
      "唯一关键词",
    );
    expect(snippet).toBe("工具输出正文与关键词无关");
  });

  it("纯 image 消息与坏 JSON 返回 null", () => {
    expect(
      extractSnippet(
        JSON.stringify([
          { type: "image", imagePath: "x.png", mime: "image/png" },
        ]),
        "x.png",
      ),
    ).toBeNull();
    expect(extractSnippet("不是JSON", "x")).toBeNull();
  });
});

describe("formatHistorySearchResults 格式化纯函数", () => {
  it("空行返回空文案", () => {
    expect(
      formatHistorySearchResults([], [{ id: 1, title: "a" }], "q", 5),
    ).toBe(HISTORY_SEARCH_EMPTY);
  });
});

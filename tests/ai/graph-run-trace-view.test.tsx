// tests/ai/graph-run-trace-view.test.tsx
// @vitest-environment jsdom
/**
 * 节点轨迹时间线(Task 14,spec §4 三层下钻第二层):三条目状态类名
 * (success=text-primary/failed=text-destructive/skipped=muted)、failed
 * 行点击展开 error.code/message 与 toolCalls 摘要(ok=false 标红)、
 * success 行点击展开输出预览(outputPreview)、skipped 行无展开、
 * parseTrace 容错。i18n mock t 直返 key(先例 graph-editor-view.test.tsx)。
 * imageGen 可视化(Task 7):outputImage 有值 → MessageImage chip（点开 lightbox 大图）替代
 * 路径文本 pre(@/lib/ipc mock + QueryClientProvider 包装,先例
 * message-image.test.tsx;仓库未装 user-event/jest-dom,点击走
 * fireEvent、断言走 toBeNull/getAttribute。react-i18next 改 partial
 * mock(MessageImage→dialog→utils 链拉 @/i18n 需 initReactI18next)。
 * 行展开下钻全文(去会话化 2026-10-28):TraceRow 起 useQuery——所有渲染
 * 须包 QueryClientProvider(renderView 助手);runNodes 按 invoke 通道名
 * 分流 mock;不展开不拉/老 run 回落预览/无 runId 纯预览三态钉住。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});

vi.mock("@/lib/ipc", () => ({
  invoke: vi.fn(async () => "data:image/png;base64,AAA"),
}));

import GraphRunTraceView, {
  parseTrace,
  type TraceEntry,
} from "@/domains/ai/orchestration/components/GraphRunTraceView";
import { invoke } from "@/lib/ipc";

afterEach(cleanup);

/** useQuery 已进 TraceRow（runNodes 下钻）：所有渲染须包 QueryClient */
function renderView(ui: ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const entries: TraceEntry[] = [
  {
    id: "collect",
    name: "收集",
    status: "success",
    startedAt: "2026-10-03T08:00:00.000Z",
    durationMs: 800,
    tokens: { promptTokens: 10, completionTokens: 5 },
    outputPreview: "上游节点输出预览文本",
  },
  {
    id: "report",
    name: "成文",
    status: "failed",
    startedAt: "2026-10-03T08:00:01.000Z",
    durationMs: 1200,
    error: {
      code: "model_missing",
      message: "模型缺失",
      toolName: "web_search",
    },
    toolCalls: [
      { name: "web_search", ok: false, durationMs: 300 },
      { name: "file_read", ok: true, durationMs: 100 },
    ],
  },
  {
    id: "notify",
    name: "通知",
    status: "skipped",
    startedAt: "2026-10-03T08:00:02.000Z",
    durationMs: 0,
  },
];

describe("GraphRunTraceView", () => {
  it("三条目状态类：success=text-primary/failed=text-destructive/skipped=text-muted-foreground", () => {
    renderView(<GraphRunTraceView trace={entries} />);
    expect(screen.getByText("收集").className).toContain("text-primary");
    expect(screen.getByText("成文").className).toContain("text-destructive");
    expect(screen.getByText("通知").className).toContain(
      "text-muted-foreground",
    );
  });

  it("failed 行点击展开 error.code(+toolName)/message 与 toolCalls 摘要(ok=false 标红)", () => {
    renderView(<GraphRunTraceView trace={entries} />);
    expect(screen.queryByText(/model_missing/)).toBeNull();
    fireEvent.click(screen.getByText("成文"));
    // code 行拼接 toolName 定位
    expect(screen.getByText("model_missing · web_search")).toBeTruthy();
    expect(screen.getByText("模型缺失")).toBeTruthy();
    expect(screen.getByText("chat:orchestration.trace.toolCalls")).toBeTruthy();
    expect(screen.getByText("web_search · 300ms").className).toContain(
      "text-destructive",
    );
    expect(screen.getByText("file_read · 100ms").className).toContain(
      "text-muted-foreground",
    );
  });

  it("failed 行展开显示 error.detail（长 stderr/响应体/堆栈全貌，与 message 200 字摘要并存）", () => {
    const withDetail: TraceEntry[] = [
      {
        ...entries[1],
        error: {
          ...entries[1].error!,
          detail:
            'Traceback (most recent call last):\n  File "app.py", line 42\nZeroDivisionError: division by zero',
        },
      },
    ];
    renderView(<GraphRunTraceView trace={withDetail} />);
    fireEvent.click(screen.getByText("成文"));
    expect(
      screen.getByText("chat:orchestration.trace.errorDetail"),
    ).toBeTruthy();
    expect(
      screen.getByText(/Traceback \(most recent call last\)/),
    ).toBeTruthy();
    expect(screen.getByText(/ZeroDivisionError/)).toBeTruthy();
  });

  it("success 行点击展开输出预览；skipped 行不可展开", () => {
    renderView(<GraphRunTraceView trace={entries} />);
    expect(screen.queryByText("上游节点输出预览文本")).toBeNull();
    fireEvent.click(screen.getByText("收集"));
    expect(screen.getByText("chat:orchestration.trace.output")).toBeTruthy();
    expect(screen.getByText("上游节点输出预览文本")).toBeTruthy();
    // skipped 无输出/错误详情：行不带展开光标，点击无展开区
    const skippedRow = screen.getByText("通知").closest("li");
    expect(skippedRow?.className).not.toContain("cursor-pointer");
    fireEvent.click(screen.getByText("通知"));
    expect(screen.getAllByText("chat:orchestration.trace.output")).toHaveLength(
      1,
    );
  });

  it("outputImage 存在 → 渲染缩略图且不显示路径文本 pre", async () => {
    const trace: TraceEntry[] = [
      {
        id: "gen",
        name: "生图",
        status: "success",
        startedAt: "2026-10-23T00:00:00Z",
        durationMs: 1000,
        outputPreview: "/abs/path/image-1.png",
        outputImage: "workflow-assets/image-1.png",
      },
    ];
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <GraphRunTraceView trace={trace} />
      </QueryClientProvider>,
    );
    // 展开行（MessageImage 现为 chip+lightbox 形态：行展开渲染文件名
    // chip，点 chip 进 lightbox 才拉 dataUrl 展大图——2026-10-24 改版）
    fireEvent.click(screen.getByText("生图"));
    fireEvent.click(screen.getByRole("button", { name: /image-1\.png/ }));
    const img = await screen.findByRole("img");
    expect(img.getAttribute("src")).toBe("data:image/png;base64,AAA");
    // 有图时不再显示路径文本块
    expect(screen.queryByText("/abs/path/image-1.png")).toBeNull();
  });

  it("空轨迹显示空态文案", () => {
    renderView(<GraphRunTraceView trace={[]} />);
    expect(screen.getByText("chat:orchestration.trace.empty")).toBeTruthy();
  });

  // —— 行展开下钻全文（去会话化 2026-10-28，runNodes 拉取）——

  /** graphRunNode 行样例（Task 1 表结构，nodeId 命中首条目 collect） */
  const nodeRow = {
    id: 21,
    runId: 9,
    nodeId: "collect",
    nodeName: "收集",
    status: "success",
    input: "完整输入全文……",
    output: "完整输出全文……",
    errorJson: null,
    toolCallsJson: null,
    promptTokens: 10,
    completionTokens: 5,
    durationMs: 800,
    startedAt: "2026-10-28T00:00:00.000Z",
    outputImage: null,
    errorOutput: null,
    fallbackJson: null,
  };

  it("runId 在场：不展开不拉；展开命中节点行 → 输入块+完整输出（标签切 outputFull，预览被覆盖）", async () => {
    // invoke mock 为文件级共享：先清调用史，只断言本用例行为
    vi.mocked(invoke).mockClear();
    vi.mocked(invoke).mockImplementation(async (channel: string) =>
      channel === "orchestration:runNodes"
        ? [nodeRow]
        : "data:image/png;base64,AAA",
    );
    renderView(<GraphRunTraceView trace={entries} runId={9} />);
    // enabled 守卫：未展开不发起 runNodes 查询
    expect(invoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("收集"));
    expect(await screen.findByText("完整输出全文……")).toBeTruthy();
    expect(
      screen.getByText("chat:orchestration.trace.outputFull"),
    ).toBeTruthy();
    expect(screen.getByText("chat:orchestration.trace.input")).toBeTruthy();
    expect(screen.getByText("完整输入全文……")).toBeTruthy();
    // 全文在场时预览文本与预览标签均不出现
    expect(screen.queryByText("上游节点输出预览文本")).toBeNull();
    expect(screen.queryByText("chat:orchestration.trace.output")).toBeNull();
  });

  it("runId 在场但节点行不命中（老 run 无节点行）→ 回落 outputPreview 预览", async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    renderView(<GraphRunTraceView trace={entries} runId={9} />);
    fireEvent.click(screen.getByText("收集"));
    expect(await screen.findByText("上游节点输出预览文本")).toBeTruthy();
    expect(screen.getByText("chat:orchestration.trace.output")).toBeTruthy();
    expect(screen.queryByText("chat:orchestration.trace.input")).toBeNull();
  });

  it("不传 runId（单节点测试等即席）→ 展开纯预览，不发起 runNodes 查询", () => {
    vi.mocked(invoke).mockClear();
    renderView(<GraphRunTraceView trace={entries} />);
    fireEvent.click(screen.getByText("收集"));
    expect(screen.getByText("上游节点输出预览文本")).toBeTruthy();
    expect(
      vi.mocked(invoke).mock.calls.map((call) => call[0] as string),
    ).not.toContain("orchestration:runNodes");
  });
});

describe("parseTrace 容错", () => {
  it("undefined/非法 JSON/非数组 → 空数组；合法 → 条目", () => {
    expect(parseTrace(undefined)).toEqual([]);
    expect(parseTrace("not json")).toEqual([]);
    expect(parseTrace('{"a":1}')).toEqual([]);
    expect(parseTrace(JSON.stringify(entries))).toHaveLength(3);
  });
});

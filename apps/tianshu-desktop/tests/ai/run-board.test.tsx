// @vitest-environment jsdom
/**
 * 右侧运行看板：条目渲染/选中高亮、置顶当前选择、失败摘要、
 * 加载更早追加、收起展开与 owner 切换重置。IPC 是唯一外部边界。
 * 仓库无 jest-dom：aria-current/disabled 用原生属性断言（同 detail-tab-bar 先例）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RunOwner } from "@tianshu/core/run-session";
import type { RunRecord } from "../../src-react/domains/ai/automation/api/automation.api";
import {
  formatDateTime,
  formatDuration,
} from "../../src-react/domains/ai/automation/lib/run-display";
import RunBoard from "../../src-react/domains/ai/automation/components/run-board";

vi.hoisted(() => {
  const memory = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => memory.set(key, value),
      removeItem: (key: string) => memory.delete(key),
      clear: () => memory.clear(),
    },
    configurable: true,
  });
});

vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
      i18n: { language: "zh-CN" },
    }),
  };
});

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", () => ({
  invoke: (channel: string, ...args: unknown[]) => invokeMock(channel, ...args),
  on: () => () => {},
  send: () => {},
}));

const TASK_OWNER: RunOwner = { kind: "task", ownerId: 4 };

interface RunCatalogEntry {
  total: number;
  pages: RunRecord[][];
}

let catalog: Record<string, RunCatalogEntry>;
let queryClient: QueryClient;

function makeRun(id: number, overrides: Partial<RunRecord> = {}): RunRecord {
  const hour = id % 24;
  return {
    id,
    taskId: 4,
    taskName: "Daily report",
    workspaceId: 7,
    sessionId: id + 100,
    attempt: 1,
    triggerType: "manual",
    status: "success",
    durationMs: 1200,
    startedAt: `2026-11-20T${String(hour).padStart(2, "0")}:00:00.000Z`,
    ...overrides,
  };
}

/** 生成一页倒序运行（id 递减；小时随 id 错开避免格式化文本撞车）。 */
function pageRuns(count: number, newestId: number): RunRecord[] {
  return Array.from({ length: count }, (_, index) => makeRun(newestId - index));
}

function invokeImpl(channel: string, ...args: unknown[]): unknown {
  if (channel === "automation:runs:page") {
    const [page, taskId] = args as [number, number];
    const entry = catalog[`task:${taskId}`];
    return { total: entry.total, items: entry.pages[page - 1] ?? [] };
  }
  if (channel === "orchestration:runs") {
    const [graphId, page] = args as [number, number];
    const entry = catalog[`graph:${graphId}`];
    return { total: entry.total, items: entry.pages[page - 1] ?? [] };
  }
  return [];
}

interface BoardProps {
  owner?: RunOwner;
  selectedRunId?: number;
  currentRun?: RunRecord;
}

function renderBoard(props: BoardProps = {}) {
  const onSelect = vi.fn();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RunBoard
        owner={props.owner ?? TASK_OWNER}
        selectedRunId={props.selectedRunId}
        currentRun={props.currentRun}
        onSelect={onSelect}
      />
    </QueryClientProvider>,
  );
  return { onSelect, ...view };
}

beforeEach(() => {
  catalog = {
    "task:4": { total: 2, pages: [[makeRun(10), makeRun(9)]] },
  };
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  invokeMock.mockReset().mockImplementation(invokeImpl);
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
});

describe("RunBoard 条目渲染与选择", () => {
  it("渲染首页条目（倒序、状态、触发、耗时、attempt）并高亮选中项", async () => {
    const [run10, run9] = catalog["task:4"].pages[0];
    renderBoard({ selectedRunId: 10 });

    const item10 = await screen.findByTestId("run-board-item-10");
    expect(item10.getAttribute("aria-current")).toBe("true");
    const item9 = screen.getByTestId("run-board-item-9");
    expect(item9.getAttribute("aria-current")).toBeNull();
    expect(
      item10.compareDocumentPosition(item9) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      within(item10).getByText(formatDateTime(run10.startedAt)),
    ).toBeTruthy();
    expect(
      within(item10).getByText("chat:automation.runs.statusSuccess"),
    ).toBeTruthy();
    expect(
      within(item10).getByText("chat:automation.runs.triggerManual"),
    ).toBeTruthy();
    expect(within(item10).getByText(formatDuration(1200))).toBeTruthy();
    expect(
      within(item10).getByText("chat:automation.runs.attempt"),
    ).toBeTruthy();
    expect(
      within(item9).getByText(formatDateTime(run9.startedAt)),
    ).toBeTruthy();
    expect(screen.getByText("chat:runSession.board.total")).toBeTruthy();
  });

  it("点击条目回调 onSelect(run.id)", async () => {
    const { onSelect } = renderBoard({ selectedRunId: 10 });
    fireEvent.click(await screen.findByTestId("run-board-item-9"));
    expect(onSelect).toHaveBeenCalledWith(9);
  });
});

describe("RunBoard 置顶当前选择", () => {
  it("选中项不在当前页时顶部置顶展示并可点击", async () => {
    const run8 = makeRun(8);
    const { onSelect } = renderBoard({ selectedRunId: 8, currentRun: run8 });

    const pinned = await screen.findByTestId("run-board-pinned");
    expect(pinned.getAttribute("aria-current")).toBe("true");
    expect(screen.getByText("chat:runSession.board.pinned")).toBeTruthy();
    expect(
      within(pinned).getByText(formatDateTime(run8.startedAt)),
    ).toBeTruthy();
    fireEvent.click(pinned);
    expect(onSelect).toHaveBeenCalledWith(8);
  });

  it("选中项已在列表内时不重复置顶", async () => {
    const run9 = catalog["task:4"].pages[0][1];
    renderBoard({ selectedRunId: 9, currentRun: run9 });

    await screen.findByTestId("run-board-item-9");
    expect(screen.queryByTestId("run-board-pinned")).toBeNull();
    expect(screen.getAllByText(formatDateTime(run9.startedAt))).toHaveLength(1);
  });
});

describe("RunBoard 失败摘要", () => {
  it("失败条目显示 localizeRunError 本地化摘要", async () => {
    catalog["task:4"] = {
      total: 1,
      pages: [
        [
          makeRun(7, {
            status: "failed",
            error: "attachment_missing: report.pdf",
          }),
        ],
      ],
    };
    renderBoard();

    const item = await screen.findByTestId("run-board-item-7");
    expect(
      within(item).getByText("chat:automation.create.attachmentMissing"),
    ).toBeTruthy();
  });
});

describe("RunBoard 加载更早记录", () => {
  it("点击后按 page=2 追加并在 total 用尽后禁用", async () => {
    catalog["task:4"] = {
      total: 25,
      pages: [pageRuns(20, 30), pageRuns(5, 10)],
    };
    renderBoard({ selectedRunId: 30 });

    expect(await screen.findByTestId("run-board-item-30")).toBeTruthy();
    expect(screen.queryByTestId("run-board-item-10")).toBeNull();
    const loadMore = screen.getByRole("button", {
      name: "chat:runSession.board.loadMore",
    });
    expect((loadMore as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(loadMore);

    expect(await screen.findByTestId("run-board-item-10")).toBeTruthy();
    expect(invokeMock).toHaveBeenCalledWith(
      "automation:runs:page",
      2,
      4,
      undefined,
    );
    expect((loadMore as HTMLButtonElement).disabled).toBe(true);
  });

  it("total 已用尽时加载按钮初始禁用", async () => {
    renderBoard();
    await screen.findByTestId("run-board-item-10");
    const loadMore = screen.getByRole("button", {
      name: "chat:runSession.board.loadMore",
    });
    expect((loadMore as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("RunBoard 收起与展开", () => {
  it("收起隐藏列表且展开恢复选中态", async () => {
    renderBoard({ selectedRunId: 10 });
    expect(
      (await screen.findByTestId("run-board-item-10")).getAttribute(
        "aria-current",
      ),
    ).toBe("true");

    fireEvent.click(
      screen.getByRole("button", { name: "chat:runSession.board.collapse" }),
    );
    expect(screen.queryByTestId("run-board-item-10")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "chat:runSession.board.expand" }),
    );
    expect(
      (await screen.findByTestId("run-board-item-10")).getAttribute(
        "aria-current",
      ),
    ).toBe("true");
  });
});

describe("RunBoard owner 切换", () => {
  it("owner 变化重置页数（不携旧 owner 的追加页）", async () => {
    catalog["task:4"] = {
      total: 25,
      pages: [pageRuns(20, 30), pageRuns(5, 10)],
    };
    catalog["task:5"] = {
      total: 2,
      pages: [[makeRun(51, { taskId: 5 }), makeRun(50, { taskId: 5 })]],
    };
    const view = renderBoard({ selectedRunId: 30 });
    expect(await screen.findByTestId("run-board-item-30")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "chat:runSession.board.loadMore" }),
    );
    await screen.findByTestId("run-board-item-10");

    view.rerender(
      <QueryClientProvider client={queryClient}>
        <RunBoard
          owner={{ kind: "task", ownerId: 5 }}
          selectedRunId={51}
          onSelect={view.onSelect}
        />
      </QueryClientProvider>,
    );

    expect(await screen.findByTestId("run-board-item-51")).toBeTruthy();
    await waitFor(() =>
      expect(
        screen.getByTestId("run-board-item-51").getAttribute("aria-current"),
      ).toBe("true"),
    );
    expect(screen.queryByTestId("run-board-item-10")).toBeNull();
    expect(invokeMock).not.toHaveBeenCalledWith(
      "automation:runs:page",
      2,
      5,
      undefined,
    );
  });
});

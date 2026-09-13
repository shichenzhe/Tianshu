// @vitest-environment jsdom
/**
 * AssetsPane 资产面板骨架测试（jsdom + testing-library，mock 骨架同
 * tests/project/project-hub.test.tsx，t 直接返回 key；AssetApi 以模块级
 * 静态类 mock 替代，list 按 folderPath 分目录返回，MemoryRouter +
 * QueryClientProvider 内渲染）：
 * - 列表行：名称/类型/大小（formatBytes 1 位小数）/相对时间列渲染
 * - 面包屑：点击文件夹行 → list 收到 join("/") 路径；点根 → list 收到 ""
 * - 排序：默认名称升序（文件夹恒在前），再点名称按钮翻转为降序；
 *   切时间排序按新旧重排；类型下拉筛掉非匹配扩展名（文件夹一并隐藏）
 * - 容量条：storageUsed 文案 + 进度条，<80% 主题色、≥80% 警示色
 * - 空目录 → assets.empty 文案
 * - 文件行点击 → openFile(1, path)；openFile 拒绝 → toast.error 透传消息
 */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

// Radix 弹层在 jsdom 的最小桩：popper 定位依赖 ResizeObserver，
// 触发器 pointerDown 分支依赖 hasPointerCapture/scrollIntoView
beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLElement.prototype.hasPointerCapture = () => false;
  window.HTMLElement.prototype.releasePointerCapture = () => {};
});

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

// @/i18n 最小桩（同 tests/project/project-hub.test.tsx）：
// 相对时间经 getDateFnsLocale 取 locale
vi.mock("@/i18n", async () => {
  const { zhCN: locale } = await import("date-fns/locale");
  return {
    default: { t: (key: string) => key },
    getDateFnsLocale: () => locale,
  };
});

// AssetApi 静态类整体 mock：九方法逐一 vi.fn
vi.mock("@/domains/project/api/asset.api", () => ({
  default: {
    list: vi.fn(),
    createFolder: vi.fn(),
    rename: vi.fn(),
    remove: vi.fn(),
    upload: vi.fn(),
    storage: vi.fn(),
    openFile: vi.fn(),
    revealFile: vi.fn(),
    pickFiles: vi.fn(),
  },
}));

import AssetsPane from "../../src-react/domains/project/components/AssetsPane";
import AssetApi from "@/domains/project/api/asset.api";
import type { AssetEntry } from "../../../electron/domains/project/asset.entity";

const DAY_MS = 24 * 3600 * 1000;
const GI = 1024 ** 3;

/** N 天前的 ISO 时间（formatDistanceToNow 断言稳定） */
const isoDaysAgo = (days: number) =>
  new Date(Date.now() - days * DAY_MS).toISOString();

const FOLDER_DOCS: AssetEntry = {
  name: "docs",
  type: "folder",
  size: 2048,
  updatedAt: isoDaysAgo(3),
  ext: null,
};
const ALPHA_TXT: AssetEntry = {
  name: "alpha.txt",
  type: "file",
  size: 1536,
  updatedAt: isoDaysAgo(1),
  ext: "txt",
};
const BETA_PDF: AssetEntry = {
  name: "beta.pdf",
  type: "file",
  size: 5 * 1024 * 1024,
  updatedAt: isoDaysAgo(3),
  ext: "pdf",
};
const ZULU_MD: AssetEntry = {
  name: "zulu.md",
  type: "file",
  size: 300,
  updatedAt: isoDaysAgo(2),
  ext: "md",
};
const NOTES_MD: AssetEntry = {
  name: "notes.md",
  type: "file",
  size: 512,
  updatedAt: isoDaysAgo(1),
  ext: "md",
};

const ROOT_ENTRIES = [FOLDER_DOCS, ALPHA_TXT, BETA_PDF, ZULU_MD];
const DOCS_ENTRIES = [NOTES_MD];

/** 渲染面板（MemoryRouter + QueryClient），list 默认根/docs 两级目录 */
function renderPane() {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>
        <AssetsPane projectId={1} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 表体行（跳过表头）：按渲染顺序取名称单元格文本 */
function rowNames(): string[] {
  return screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => (row as HTMLTableRowElement).cells[0].textContent ?? "");
}

beforeEach(() => {
  vi.mocked(AssetApi.list)
    .mockReset()
    .mockImplementation(async (_projectId: number, folderPath = "") =>
      folderPath === "docs" ? DOCS_ENTRIES : ROOT_ENTRIES,
    );
  vi.mocked(AssetApi.storage)
    .mockReset()
    .mockResolvedValue({ usedBytes: 0.5 * 5 * GI, quotaBytes: 5 * GI });
  vi.mocked(AssetApi.openFile).mockReset().mockResolvedValue(undefined);
  vi.mocked(AssetApi.revealFile).mockReset().mockResolvedValue(undefined);
  toastMock.success.mockClear();
  toastMock.error.mockClear();
});

afterEach(cleanup);

describe("资产面板", () => {
  it("渲染列表行：名称/类型/大小/更新时间列", async () => {
    renderPane();
    await screen.findByText("alpha.txt");

    const rows = screen.getAllByRole("row");
    expect(within(rows[0]).getByText("project:assets.name")).toBeTruthy();
    expect(within(rows[0]).getByText("project:assets.type")).toBeTruthy();
    expect(within(rows[0]).getByText("project:assets.size")).toBeTruthy();
    expect(within(rows[0]).getByText("project:assets.updatedAt")).toBeTruthy();

    const [docsRow, alphaRow, betaRow, zuluRow] = rows.slice(1);
    expect(within(docsRow).getByText("docs")).toBeTruthy();
    expect(within(docsRow).getByText("project:assets.folder")).toBeTruthy();
    expect(within(docsRow).getByText("2.0 KB")).toBeTruthy();
    expect(within(docsRow).getByText("3 天前")).toBeTruthy();
    expect(within(alphaRow).getByText("txt")).toBeTruthy();
    expect(within(alphaRow).getByText("1.5 KB")).toBeTruthy();
    expect(within(alphaRow).getByText("1 天前")).toBeTruthy();
    expect(within(betaRow).getByText("5.0 MB")).toBeTruthy();
    expect(within(zuluRow).getByText("300 B")).toBeTruthy();
  });

  it("面包屑：点文件夹行进入子目录，点根返回", async () => {
    renderPane();
    fireEvent.click(await screen.findByText("docs"));

    await waitFor(() => expect(AssetApi.list).toHaveBeenCalledWith(1, "docs"));
    expect(await screen.findByText("notes.md")).toBeTruthy();
    expect(screen.queryByText("alpha.txt")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "project:assets.title" }),
    );
    await waitFor(() => expect(AssetApi.list).toHaveBeenCalledWith(1, ""));
    expect(await screen.findByText("alpha.txt")).toBeTruthy();
  });

  it("排序切换与类型筛选", async () => {
    renderPane();
    await screen.findByText("alpha.txt");
    // 默认名称升序（文件夹恒在前）
    expect(rowNames()).toEqual(["docs", "alpha.txt", "beta.pdf", "zulu.md"]);

    // 再点名称按钮（已激活）→ 翻转为降序，文件夹仍在前
    fireEvent.click(
      screen.getByRole("button", { name: "project:assets.sortName" }),
    );
    expect(rowNames()).toEqual(["docs", "zulu.md", "beta.pdf", "alpha.txt"]);

    // 切时间排序（升序 = 旧→新）：beta(3 天) → zulu(2 天) → alpha(1 天)
    fireEvent.click(
      screen.getByRole("button", { name: "project:assets.sortTime" }),
    );
    expect(rowNames()).toEqual(["docs", "beta.pdf", "zulu.md", "alpha.txt"]);

    // 类型筛选 pdf → 仅剩匹配扩展名（文件夹与非匹配文件一并隐藏）
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "project:assets.type" }),
    );
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByText("pdf"));
    await waitFor(() => expect(screen.queryByText("alpha.txt")).toBeNull());
    expect(screen.queryByText("docs")).toBeNull();
    expect(screen.queryByText("zulu.md")).toBeNull();
    expect(screen.getByText("beta.pdf")).toBeTruthy();
    expect(rowNames()).toEqual(["beta.pdf"]);
  });

  it("容量条：≥80% 警示色 + 配额提示文案", async () => {
    vi.mocked(AssetApi.storage).mockResolvedValue({
      usedBytes: 0.85 * 5 * GI,
      quotaBytes: 5 * GI,
    });
    renderPane();
    await screen.findByText("alpha.txt");

    expect(screen.getByText("project:assets.storageUsed")).toBeTruthy();
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("85");
    expect(bar.className).toContain("bg-destructive");
    expect(screen.getByText("project:assets.quotaExceeded")).toBeTruthy();
  });

  it("容量条：<80% 主题色且无配额提示", async () => {
    renderPane();
    await screen.findByText("alpha.txt");

    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("50");
    expect(bar.className).toContain("bg-primary");
    expect(bar.className).not.toContain("bg-destructive");
    expect(screen.queryByText("project:assets.quotaExceeded")).toBeNull();
  });

  it("空目录 → 空态文案", async () => {
    vi.mocked(AssetApi.list).mockResolvedValue([]);
    renderPane();
    expect(await screen.findByText("project:assets.empty")).toBeTruthy();
    expect(screen.queryByRole("row")).toBeNull();
  });

  it("文件行点击 → openFile(1, 路径)", async () => {
    renderPane();
    fireEvent.click(await screen.findByText("alpha.txt"));

    await waitFor(() =>
      expect(AssetApi.openFile).toHaveBeenCalledWith(1, "alpha.txt"),
    );
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("openFile 拒绝 → toast.error 透传错误消息", async () => {
    vi.mocked(AssetApi.openFile).mockRejectedValue(new Error("无法打开文件"));
    renderPane();
    fireEvent.click(await screen.findByText("alpha.txt"));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("无法打开文件"),
    );
  });
});

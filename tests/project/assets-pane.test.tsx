// @vitest-environment jsdom
/**
 * AssetsPane 资产面板测试（jsdom + testing-library，mock 骨架同
 * tests/project/project-hub.test.tsx，t 返回 key、带插值参数时追加 JSON
 * 便于断言 toast/文案含变量；AssetApi 以模块级静态类 mock 替代，list 按
 * folderPath 分目录返回，MemoryRouter + QueryClientProvider 内渲染）：
 * - 列表行：名称/类型/大小（formatBytes 1 位小数）/相对时间列渲染
 * - 面包屑：点击文件夹行 → list 收到 join("/") 路径；点根 → list 收到 ""
 * - 排序：默认名称升序（文件夹恒在前），再点名称按钮翻转为降序；
 *   切时间排序默认降序（最新在前），再点翻转；类型下拉筛掉非匹配文件
 *   （文件夹是导航入口恒显示）
 * - 容量条：storageUsed 文案 + 进度条，<80% 主题色、≥80% 警示色
 * - 初始加载（list 未决）→ 轻量加载态且无空表头；空目录 → assets.empty；
 *   筛选后无匹配（entries 非空、visibleEntries 空）→ assets.noMatch
 * - 上传：pickFiles null 取消不调 upload；成功 → uploadSuccess（count）+
 *   列表/容量双失效；部分失败 → uploadPartial 警示；用量打满 → quotaExceeded
 * - 拖拽：dragenter 子元素进出覆盖层稳定（计数器），drop 经
 *   window.filePath.getPathForFile 解析路径 → upload
 * - 新建文件夹 Dialog → createFolder + toast 含后端返回最终名
 * - 重命名 Dialog：预填当前名、未修改/清空禁用确认，确认 → rename + toast
 * - 删除 AlertDialog：通用文案 → remove + 列表/容量失效 + deleted toast
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
  act,
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
  return {
    ...actual,
    useTranslation: () => ({
      // 带插值参数时追加 JSON：断言 toast/文案携带返回名、条数等变量
      t: (key: string, opts?: Record<string, unknown>) =>
        opts ? `${key}:${JSON.stringify(opts)}` : key,
    }),
  };
});

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}));
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

/** 名称所在表体行 */
function rowContaining(name: string): HTMLTableRowElement {
  const row = screen
    .getAllByRole("row")
    .find((entry) => entry.textContent?.includes(name));
  if (!row) {
    throw new Error(`row not found: ${name}`);
  }
  return row as HTMLTableRowElement;
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
  vi.mocked(AssetApi.pickFiles).mockReset().mockResolvedValue(null);
  vi.mocked(AssetApi.upload)
    .mockReset()
    .mockResolvedValue({ uploaded: [], failed: [] });
  vi.mocked(AssetApi.createFolder).mockReset().mockResolvedValue("新建文件夹");
  vi.mocked(AssetApi.rename).mockReset().mockResolvedValue("renamed.txt");
  vi.mocked(AssetApi.remove).mockReset().mockResolvedValue(undefined);
  // 拖拽路径桥默认返回空串（无路径可解析 → drop 不触发上传），用例内覆写
  window.filePath = { getPathForFile: () => "" };
  toastMock.success.mockClear();
  toastMock.error.mockClear();
  toastMock.warning.mockClear();
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

  it("排序切换与类型筛选（文件夹恒显示）", async () => {
    renderPane();
    await screen.findByText("alpha.txt");
    // 默认名称升序（文件夹恒在前）
    expect(rowNames()).toEqual(["docs", "alpha.txt", "beta.pdf", "zulu.md"]);

    // 再点名称按钮（已激活）→ 翻转为降序，文件夹仍在前
    fireEvent.click(
      screen.getByRole("button", { name: "project:assets.sortName" }),
    );
    expect(rowNames()).toEqual(["docs", "zulu.md", "beta.pdf", "alpha.txt"]);

    // 切时间排序默认降序（最新在前）：alpha(1 天) → zulu(2 天) → beta(3 天)
    fireEvent.click(
      screen.getByRole("button", { name: "project:assets.sortTime" }),
    );
    expect(rowNames()).toEqual(["docs", "alpha.txt", "zulu.md", "beta.pdf"]);
    // 再点时间按钮 → 翻转升序（旧→新）
    fireEvent.click(
      screen.getByRole("button", { name: "project:assets.sortTime" }),
    );
    expect(rowNames()).toEqual(["docs", "beta.pdf", "zulu.md", "alpha.txt"]);
    // 切回名称 → 重置升序
    fireEvent.click(
      screen.getByRole("button", { name: "project:assets.sortName" }),
    );
    expect(rowNames()).toEqual(["docs", "alpha.txt", "beta.pdf", "zulu.md"]);

    // 类型筛选 pdf → 仅文件被过滤，文件夹是导航入口恒显示
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "project:assets.type" }),
    );
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByText("pdf"));
    await waitFor(() => expect(screen.queryByText("alpha.txt")).toBeNull());
    expect(screen.queryByText("zulu.md")).toBeNull();
    expect(screen.getByText("beta.pdf")).toBeTruthy();
    expect(rowNames()).toEqual(["docs", "beta.pdf"]);
  });

  it("容量条：≥80% 警示色 + 配额提示文案", async () => {
    vi.mocked(AssetApi.storage).mockResolvedValue({
      usedBytes: 0.85 * 5 * GI,
      quotaBytes: 5 * GI,
    });
    renderPane();
    await screen.findByText("alpha.txt");

    expect(screen.getByText(/^project:assets.storageUsed/)).toBeTruthy();
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

  it("初始加载（list 未决）→ 轻量加载态，不闪现空表头", async () => {
    vi.mocked(AssetApi.list).mockImplementation(
      () => new Promise<AssetEntry[]>(() => {}),
    );
    renderPane();

    expect(await screen.findByText("common:loading")).toBeTruthy();
    expect(screen.queryByRole("row")).toBeNull();
  });

  it("空目录 → 空态文案", async () => {
    vi.mocked(AssetApi.list).mockResolvedValue([]);
    renderPane();
    expect(await screen.findByText("project:assets.empty")).toBeTruthy();
    expect(screen.queryByRole("row")).toBeNull();
  });

  it("筛选后无匹配文件 → noMatch 提示（entries 非空、可见项空）", async () => {
    let rootEntries: AssetEntry[] = [ALPHA_TXT, BETA_PDF];
    vi.mocked(AssetApi.list).mockImplementation(
      async (_projectId: number, folderPath = "") =>
        folderPath === "docs" ? DOCS_ENTRIES : [...rootEntries],
    );
    // 删除唯一 pdf 后重取：剩余文件均不匹配筛选 → 无匹配提示
    vi.mocked(AssetApi.remove).mockImplementation(async () => {
      rootEntries = [ALPHA_TXT];
    });
    renderPane();
    await screen.findByText("beta.pdf");

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "project:assets.type" }),
    );
    fireEvent.click(within(await screen.findByRole("menu")).getByText("pdf"));
    await waitFor(() => expect(screen.queryByText("alpha.txt")).toBeNull());

    fireEvent.click(
      within(rowContaining("beta.pdf")).getByRole("button", {
        name: "project:assets.delete",
      }),
    );
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "common:delete",
      }),
    );
    expect(await screen.findByText("project:assets.noMatch")).toBeTruthy();
    expect(screen.queryByRole("row")).toBeNull();
  });

  it("上传按钮：pickFiles 取消（null）→ 不调 upload", async () => {
    vi.mocked(AssetApi.pickFiles).mockResolvedValue(null);
    renderPane();
    fireEvent.click(
      await screen.findByRole("button", { name: "project:assets.upload" }),
    );

    await waitFor(() => expect(AssetApi.pickFiles).toHaveBeenCalled());
    await act(async () => {});
    expect(AssetApi.upload).not.toHaveBeenCalled();
  });

  it("上传按钮：成功 → upload + 列表/容量双失效 + uploadSuccess toast", async () => {
    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    vi.mocked(AssetApi.pickFiles).mockResolvedValue([
      "/tmp/a.pdf",
      "/tmp/b.pdf",
    ]);
    vi.mocked(AssetApi.upload).mockResolvedValue({
      uploaded: ["a.pdf", "b.pdf"],
      failed: [],
    });
    renderPane();
    fireEvent.click(
      await screen.findByRole("button", { name: "project:assets.upload" }),
    );

    await waitFor(() =>
      expect(AssetApi.upload).toHaveBeenCalledWith(1, "", [
        "/tmp/a.pdf",
        "/tmp/b.pdf",
      ]),
    );
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith(
        'project:assets.uploadSuccess:{"count":2}',
      ),
    );
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["projectAssets", 1],
      }),
    );
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["projectAssetStorage", 1],
      }),
    );
    // 用量 50% → 无配额警示
    expect(toastMock.warning).not.toHaveBeenCalled();
    invalidateSpy.mockRestore();
  });

  it("上传：部分失败 → uploadPartial 警示；用量打满 → quotaExceeded 警示", async () => {
    vi.mocked(AssetApi.pickFiles).mockResolvedValue(["/tmp/a.pdf"]);
    vi.mocked(AssetApi.upload).mockResolvedValue({
      uploaded: ["a.pdf"],
      failed: ["b.pdf"],
    });
    vi.mocked(AssetApi.storage).mockResolvedValue({
      usedBytes: 5 * GI,
      quotaBytes: 5 * GI,
    });
    renderPane();
    fireEvent.click(
      await screen.findByRole("button", { name: "project:assets.upload" }),
    );

    await waitFor(() => expect(toastMock.warning).toHaveBeenCalledTimes(2));
    expect(toastMock.warning).toHaveBeenNthCalledWith(
      1,
      'project:assets.uploadPartial:{"uploaded":1,"failed":1}',
    );
    expect(toastMock.warning).toHaveBeenNthCalledWith(
      2,
      "project:assets.quotaExceeded",
    );
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it("拖拽：覆盖层子元素进出稳定（计数器），drop 经 getPathForFile → upload", async () => {
    const getPathForFile = vi.fn((file: File) => `/abs/${file.name}`);
    window.filePath = { getPathForFile };
    vi.mocked(AssetApi.upload).mockResolvedValue({
      uploaded: ["a.pdf"],
      failed: [],
    });
    renderPane();
    const cell = await screen.findByText("alpha.txt");

    // 进入 → 覆盖层显示
    fireEvent.dragEnter(cell, { dataTransfer: { types: ["Files"] } });
    expect(await screen.findByText("project:assets.dropHere")).toBeTruthy();
    // 子元素间移动（enter/leave 配对）不隐藏
    fireEvent.dragEnter(screen.getByText("beta.pdf"), {
      dataTransfer: { types: ["Files"] },
    });
    fireEvent.dragLeave(cell, { dataTransfer: { types: ["Files"] } });
    expect(screen.getByText("project:assets.dropHere")).toBeTruthy();
    // 离开区域（最后一个 leave）→ 隐藏
    fireEvent.dragLeave(screen.getByText("beta.pdf"), {
      dataTransfer: { types: ["Files"] },
    });
    expect(screen.queryByText("project:assets.dropHere")).toBeNull();

    // drop → 解析绝对路径 → upload 到当前目录
    fireEvent.dragEnter(cell, { dataTransfer: { types: ["Files"] } });
    const file = new File(["content"], "a.pdf", { type: "application/pdf" });
    fireEvent.drop(cell, { dataTransfer: { files: [file], types: ["Files"] } });
    await waitFor(() =>
      expect(AssetApi.upload).toHaveBeenCalledWith(1, "", ["/abs/a.pdf"]),
    );
    expect(getPathForFile).toHaveBeenCalledWith(file);
    expect(screen.queryByText("project:assets.dropHere")).toBeNull();
  });

  it("新建文件夹：Dialog 输入 → createFolder + toast 含返回最终名", async () => {
    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    vi.mocked(AssetApi.createFolder).mockResolvedValue("资料 (2)");
    renderPane();
    fireEvent.click(
      await screen.findByRole("button", { name: "project:assets.newFolder" }),
    );

    const input = await screen.findByLabelText("project:assets.name");
    // 空名禁用确认
    expect(
      (
        screen.getByRole("button", {
          name: "common:confirm",
        }) as HTMLButtonElement | null
      )?.disabled,
    ).toBe(true);
    fireEvent.change(input, { target: { value: "资料" } });
    fireEvent.click(screen.getByRole("button", { name: "common:confirm" }));

    await waitFor(() =>
      expect(AssetApi.createFolder).toHaveBeenCalledWith(1, "", "资料"),
    );
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith(
        'project:assets.folderCreated:{"name":"资料 (2)"}',
      ),
    );
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["projectAssets", 1],
      }),
    );
    invalidateSpy.mockRestore();
  });

  it("重命名：预填当前名，未修改/清空禁用确认，确认 → rename + toast", async () => {
    vi.mocked(AssetApi.rename).mockResolvedValue("beta2.pdf");
    renderPane();
    await screen.findByText("beta.pdf");
    fireEvent.click(
      within(rowContaining("beta.pdf")).getByRole("button", {
        name: "project:assets.rename",
      }),
    );

    const input = await screen.findByLabelText("project:assets.name");
    expect((input as HTMLInputElement).value).toBe("beta.pdf");
    const confirm = screen.getByRole("button", {
      name: "common:confirm",
    }) as HTMLButtonElement;
    // 未修改（同名改自身会得 "原名 (2)"）禁用防呆
    expect(confirm.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "  " } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "beta2.pdf" } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(AssetApi.rename).toHaveBeenCalledWith(1, "beta.pdf", "beta2.pdf"),
    );
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith(
        'project:assets.renamed:{"name":"beta2.pdf"}',
      ),
    );
  });

  it("删除：二次确认通用文案 → remove + 列表/容量失效 + deleted toast", async () => {
    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    renderPane();
    await screen.findByText("beta.pdf");
    fireEvent.click(
      within(rowContaining("beta.pdf")).getByRole("button", {
        name: "project:assets.delete",
      }),
    );

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("project:assets.deleteTitle")).toBeTruthy();
    // 通用删除文案（文件夹懒统计为字节数，不硬凑条目数）
    expect(within(dialog).getByText("project:assets.deleteDesc")).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "common:delete" }),
    );

    await waitFor(() =>
      expect(AssetApi.remove).toHaveBeenCalledWith(1, "beta.pdf"),
    );
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith("project:assets.deleted"),
    );
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["projectAssets", 1],
      }),
    );
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["projectAssetStorage", 1],
      }),
    );
    invalidateSpy.mockRestore();
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

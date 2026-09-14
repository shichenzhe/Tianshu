// @vitest-environment jsdom
/**
 * PlanItemAttachments 事项附件区测试（子系统 D Task 4，jsdom +
 * testing-library，mock 骨架同 plan-item-dialog.test.tsx：t 返回 key、
 * sonner、@/i18n 最小桩、Radix 弹层桩、QueryClientProvider）：
 * - 回形针菜单两项：上传文件 / 从资产挑选；本地任务（projectId null）
 *   附件区整体不渲染
 * - 上传：pickFiles → upload(projectId, "attachments", 绝对路径) → onChange
 *   追加暂存项（无 id，assetPath = attachments/<后端返回最终名>）
 * - 挑选：listWorkspaceFiles(workspaceId) 递归相对路径列表 + 过滤搜索框，
 *   点选 → onChange 追加（fileName = 路径末段）
 * - chips：value 渲染文件名 + 删除 ×；已挂（有 id）删除 → removeAttachment
 *   通道 + 附件 key 失效 + 上抛移除；暂存项删除仅上抛（不走通道）
 * - 上传失败（failed 非空）→ toast.error(uploadFailed) 且不上抛
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

// Radix 弹层在 jsdom 的最小桩：popper 定位依赖 ResizeObserver
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

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toastMock }));

// mapIpcError 依赖 @/i18n 实例，最小桩避免拉起完整 i18n 栈
vi.mock("@/i18n", () => ({
  default: { t: (key: string) => key },
}));

// 资产挑选数据源：file:listWorkspaceFiles 经 invoke 直调（通道已在 ipc.ts）
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ invoke: invokeMock }));

// AssetApi 静态类整体 mock（上传链路 pickFiles/upload）
vi.mock("@/domains/project/api/asset.api", () => ({
  default: {
    pickFiles: vi.fn(),
    upload: vi.fn(),
  },
}));

// PlanItemApi 整体 mock：附件区只消费 removeAttachment + key 工厂
vi.mock("@/domains/project/api/plan-item.api", () => ({
  default: {
    removeAttachment: vi.fn(),
  },
  PLAN_ITEM_ATTACHMENTS_KEY: (planItemId: number) => [
    "planItemAttachments",
    planItemId,
  ],
}));

import PlanItemAttachments from "../../src-react/domains/project/components/PlanItemAttachments";
import AssetApi from "@/domains/project/api/asset.api";
import PlanItemApi from "@/domains/project/api/plan-item.api";
import type { PendingAttachment } from "../../src-react/domains/project/components/PlanItemAttachments";

interface RenderOptions {
  projectId?: number | null;
  workspaceId?: number;
  planItemId?: number;
  value?: PendingAttachment[];
}

/** 渲染附件区（默认项目任务 + 资产空间 30 + 事项 7），返回 onChange 探针 */
function renderAttachments({
  projectId = 1,
  workspaceId = 30,
  planItemId = 7,
  value = [],
}: RenderOptions = {}) {
  const onChange = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const { container } = render(
    <QueryClientProvider client={client}>
      <PlanItemAttachments
        projectId={projectId}
        workspaceId={workspaceId}
        planItemId={planItemId}
        value={value}
        onChange={onChange}
      />
    </QueryClientProvider>,
  );
  return { container, onChange };
}

/** 点开回形针菜单，返回 Popover 内容元素 */
async function openMenu() {
  fireEvent.click(
    screen.getByRole("button", { name: "project:plan.attachments" }),
  );
  return screen.findByRole("dialog", { name: "project:plan.attachments" });
}

beforeEach(() => {
  invokeMock.mockReset().mockResolvedValue([]);
  vi.mocked(AssetApi.pickFiles).mockReset().mockResolvedValue(null);
  vi.mocked(AssetApi.upload).mockReset().mockResolvedValue({
    uploaded: [],
    failed: [],
  });
  vi.mocked(PlanItemApi.removeAttachment)
    .mockReset()
    .mockResolvedValue(undefined);
  toastMock.success.mockClear();
  toastMock.error.mockClear();
});

afterEach(cleanup);

describe("PlanItemAttachments 菜单与可见性", () => {
  it("回形针菜单两项：上传文件 / 从资产挑选", async () => {
    renderAttachments();
    const panel = await openMenu();
    expect(
      within(panel).getByRole("button", { name: "project:plan.upload" }),
    ).toBeTruthy();
    expect(
      within(panel).getByRole("button", {
        name: "project:plan.pickFromAssets",
      }),
    ).toBeTruthy();
  });

  it("本地任务（projectId null）附件区整体不渲染", () => {
    const { container } = renderAttachments({ projectId: null });
    expect(container.firstChild).toBeNull();
    expect(
      screen.queryByRole("button", { name: "project:plan.attachments" }),
    ).toBeNull();
  });
});

describe("PlanItemAttachments 上传", () => {
  it("pickFiles → upload 至 attachments/ 子目录 → onChange 暂存项（无 id）", async () => {
    vi.mocked(AssetApi.pickFiles).mockResolvedValue(["/tmp/a.pdf"]);
    vi.mocked(AssetApi.upload).mockResolvedValue({
      uploaded: ["a.pdf"],
      failed: [],
    });
    const { onChange } = renderAttachments();
    const panel = await openMenu();
    fireEvent.click(
      within(panel).getByRole("button", { name: "project:plan.upload" }),
    );

    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(AssetApi.upload).toHaveBeenCalledWith(1, "attachments", [
      "/tmp/a.pdf",
    ]);
    expect(onChange).toHaveBeenCalledWith([
      { fileName: "a.pdf", assetPath: "attachments/a.pdf" },
    ]);
    // 暂存项无 id（保存成功后才批量建关联）
    expect(onChange.mock.calls[0][0][0].id).toBeUndefined();
  });

  it("failed 非空 → toast.error(uploadFailed) 且不上抛", async () => {
    vi.mocked(AssetApi.pickFiles).mockResolvedValue(["/tmp/big.zip"]);
    vi.mocked(AssetApi.upload).mockResolvedValue({
      uploaded: [],
      failed: ["big.zip"],
    });
    const { onChange } = renderAttachments();
    const panel = await openMenu();
    fireEvent.click(
      within(panel).getByRole("button", { name: "project:plan.upload" }),
    );

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("project:plan.uploadFailed"),
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("pickFiles 取消（null）不调 upload", async () => {
    vi.mocked(AssetApi.pickFiles).mockResolvedValue(null);
    const { onChange } = renderAttachments();
    const panel = await openMenu();
    fireEvent.click(
      within(panel).getByRole("button", { name: "project:plan.upload" }),
    );

    await waitFor(() => expect(AssetApi.pickFiles).toHaveBeenCalledTimes(1));
    expect(AssetApi.upload).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("PlanItemAttachments 从资产挑选", () => {
  it("listWorkspaceFiles 递归列表 + 过滤搜索框，点选追加（fileName = 末段）", async () => {
    invokeMock.mockResolvedValue(["docs/b.md", "attachments/a.pdf"]);
    const { onChange } = renderAttachments();
    const panel = await openMenu();
    fireEvent.click(
      within(panel).getByRole("button", {
        name: "project:plan.pickFromAssets",
      }),
    );

    expect(invokeMock).toHaveBeenCalledWith("file:listWorkspaceFiles", 30);
    const filterInput = await within(panel).findByLabelText(
      "project:plan.filterAssets",
    );
    await waitFor(() =>
      expect(
        within(panel).getByRole("button", { name: "docs/b.md" }),
      ).toBeTruthy(),
    );
    expect(
      within(panel).getByRole("button", { name: "attachments/a.pdf" }),
    ).toBeTruthy();

    // 过滤搜索框：输入 docs 仅剩 docs/b.md
    fireEvent.change(filterInput, { target: { value: "docs" } });
    expect(
      within(panel).queryByRole("button", { name: "attachments/a.pdf" }),
    ).toBeNull();
    expect(
      within(panel).getByRole("button", { name: "docs/b.md" }),
    ).toBeTruthy();

    fireEvent.click(within(panel).getByRole("button", { name: "docs/b.md" }));
    expect(onChange).toHaveBeenCalledWith([
      { fileName: "b.md", assetPath: "docs/b.md" },
    ]);
  });
});

describe("PlanItemAttachments chips 删除", () => {
  const ATTACHED: PendingAttachment = {
    id: 5,
    fileName: "spec.pdf",
    assetPath: "attachments/spec.pdf",
  };
  const PENDING: PendingAttachment = {
    fileName: "draft.md",
    assetPath: "docs/draft.md",
  };

  /** 取文件名 chip 容器（span） */
  const getChip = (fileName: string) =>
    screen.getByText(fileName).closest("span") as HTMLElement;

  it("value 渲染文件名 chips + 删除 ×", () => {
    renderAttachments({ value: [ATTACHED, PENDING] });
    expect(screen.getByText("spec.pdf")).toBeTruthy();
    expect(screen.getByText("draft.md")).toBeTruthy();
  });

  it("已挂（有 id）删除 → removeAttachment 通道 + key 失效 + 上抛移除", async () => {
    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    const { onChange } = renderAttachments({ value: [ATTACHED, PENDING] });
    fireEvent.click(
      within(getChip("spec.pdf")).getByRole("button", { name: "common:close" }),
    );

    await waitFor(() =>
      expect(PlanItemApi.removeAttachment).toHaveBeenCalledWith(5),
    );
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["planItemAttachments", 7],
      }),
    );
    expect(onChange).toHaveBeenCalledWith([PENDING]);
    invalidateSpy.mockRestore();
  });

  it("暂存项删除仅上抛移除，不走通道", async () => {
    const { onChange } = renderAttachments({ value: [ATTACHED, PENDING] });
    fireEvent.click(
      within(getChip("draft.md")).getByRole("button", { name: "common:close" }),
    );

    // 仅暂存项被移除，已挂记录保留在列表中
    await waitFor(() => expect(onChange).toHaveBeenCalledWith([ATTACHED]));
    expect(PlanItemApi.removeAttachment).not.toHaveBeenCalled();
  });
});

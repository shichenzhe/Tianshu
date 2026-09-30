// @vitest-environment jsdom
/**
 * HandoverDialog 转办弹框测试（三期批 12）：Loading→预填（可编辑）、
 * 失败→提示+重试、确认创建参数（title/description/source=manual）+
 * 双失效缓存 + 关闭、标题空禁用、创建失败 toast 不关闭。
 * 属性与附件增强：胶囊行改状态/处理人/标签/双日期 → create 载荷携带
 * （日期 UTC 零点 ISO、assigneeId 缺省当前用户）、回形针上传暂存附件 →
 * create 成功后按返回 id 挂库（失败仅 toast 不阻断关闭）。
 * ChatApi/PlanItemApi/ProjectApi/AssetApi/user.store stub；mock 骨架同
 * plan-item-dialog.test
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

vi.hoisted(() => {
  const memory = new Map<string, string>();
  const stub = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key),
    clear: () => memory.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: stub,
    configurable: true,
    writable: true,
  });
});

vi.mock("@/i18n", () => ({
  default: { t: (key: string) => key },
}));
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toastMock }));

// ChatApi stub：handoverSummary 可控 promise（Loading/成功/失败/重试断言）
const handoverMock = vi.hoisted(() => vi.fn());
vi.mock("@/domains/ai/api/chat.api", () => ({
  default: { handoverSummary: handoverMock },
}));
vi.mock("@/domains/ai/chat/lib/error-message", () => ({
  mapIpcError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

const createMock = vi.hoisted(() => vi.fn());
const createAttachmentMock = vi.hoisted(() => vi.fn());
vi.mock("@/domains/project/api/plan-item.api", () => ({
  default: { create: createMock, createAttachment: createAttachmentMock },
  PLAN_ITEMS_KEY: (projectId: number) => ["planItems", projectId],
  PLAN_ITEMS_MINE_KEY: (userId: number) => ["planItemsMine", userId],
  PLAN_ITEM_ATTACHMENTS_KEY: (planItemId: number) => [
    "planItemAttachments",
    planItemId,
  ],
}));

// ProjectApi.listMembers（处理人胶囊成员源）整体 mock
vi.mock("@/domains/project/api/project.api", () => ({
  default: { listMembers: vi.fn() },
}));

// AssetApi 静态类整体 mock（附件上传链路 pickFiles/upload）
vi.mock("@/domains/project/api/asset.api", () => ({
  default: {
    pickFiles: vi.fn(),
    upload: vi.fn(),
  },
}));

import ProjectApi from "@/domains/project/api/project.api";
import AssetApi from "@/domains/project/api/asset.api";

vi.mock("@/domains/user/store/user.store", () => ({
  useUserStore: (selector?: (state: { user: { id: number } }) => unknown) =>
    selector ? selector({ user: { id: 3 } }) : { user: { id: 3 } },
}));

import HandoverDialog from "../../src-react/domains/project/components/HandoverDialog";

function renderDialog(open = true) {
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <HandoverDialog
        open={open}
        onOpenChange={onOpenChange}
        projectId={11}
        sessionId={22}
        assetWorkspaceId={33}
      />
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

const SUMMARY_MD = "## 工作目标\n接管项目";

/** 成员列表（处理人胶囊数据源；当前用户 id=3 之外一名成员） */
const MEMBERS = [
  { userId: 3, nickname: "我" },
  { userId: 8, nickname: "李四" },
];

beforeEach(() => {
  handoverMock.mockReset();
  createMock.mockReset().mockResolvedValue({ id: 99 });
  createAttachmentMock.mockReset().mockResolvedValue(undefined);
  vi.mocked(ProjectApi.listMembers).mockReset().mockResolvedValue(MEMBERS);
  toastMock.success.mockClear();
  toastMock.error.mockClear();
});

afterEach(cleanup);

/* ---------- 属性胶囊行 + 附件区 helper（同 plan-item-dialog.test） ---------- */

/** 点开属性胶囊 Popover，返回内容元素（选项按钮/日期框均在其内） */
async function openCapsule(capsuleName: string) {
  fireEvent.click(screen.getByRole("button", { name: capsuleName }));
  return screen.findByRole("dialog", { name: capsuleName });
}

/** 经回形针菜单上传一个暂存附件（AssetApi 预置 mock → chip 出现） */
async function uploadPendingAttachment(fileName: string, absPath: string) {
  vi.mocked(AssetApi.pickFiles).mockResolvedValue([absPath]);
  vi.mocked(AssetApi.upload).mockResolvedValue({
    uploaded: [fileName],
    failed: [],
  });
  fireEvent.click(
    screen.getByRole("button", { name: "project:plan.attachments" }),
  );
  const panel = await screen.findByRole("dialog", {
    name: "project:plan.attachments",
  });
  fireEvent.click(
    within(panel).getByRole("button", { name: "project:plan.upload" }),
  );
  await waitFor(() => expect(screen.getByText(fileName)).toBeTruthy());
}

describe("HandoverDialog 转办弹框（批 12）", () => {
  it("打开即调摘要：Loading 提示可见 → 成功预填文本域（可编辑）", async () => {
    let resolveSummary: (text: string) => void = () => {};
    handoverMock.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveSummary = resolve;
      }),
    );
    renderDialog();

    expect(handoverMock).toHaveBeenCalledWith(22);
    expect(screen.getByText("project:handover.generating")).toBeTruthy();
    const textarea = screen.getByLabelText(
      "project:handover.summaryLabel",
    ) as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);

    resolveSummary(SUMMARY_MD);
    await waitFor(() => expect(textarea.value).toBe(SUMMARY_MD));
    expect(textarea.disabled).toBe(false);
    expect(screen.queryByText("project:handover.generating")).toBeNull();
  });

  it("失败：提示 + 重试按钮；重试再次调用摘要接口", async () => {
    handoverMock.mockRejectedValueOnce(new Error("TIMEOUT"));
    renderDialog();
    expect(await screen.findByText("project:handover.failedHint")).toBeTruthy();

    handoverMock.mockResolvedValueOnce(SUMMARY_MD);
    fireEvent.click(
      screen.getByRole("button", { name: "project:handover.retry" }),
    );
    await waitFor(() =>
      expect(
        (
          screen.getByLabelText(
            "project:handover.summaryLabel",
          ) as HTMLTextAreaElement
        ).value,
      ).toBe(SUMMARY_MD),
    );
    expect(handoverMock).toHaveBeenCalledTimes(2);
  });

  it("确认：标题空禁用；填标题后创建（description=摘要当前值/source=manual）+ 双失效 + 关闭", async () => {
    handoverMock.mockResolvedValue(SUMMARY_MD);
    const { onOpenChange } = renderDialog();
    const confirm = await screen.findByRole("button", {
      name: "common:confirm",
    });
    expect(confirm.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("project:plan.title"), {
      target: { value: "项目交接" },
    });
    // 摘要可编辑：改后再确认传当前值
    fireEvent.change(screen.getByLabelText("project:handover.summaryLabel"), {
      target: { value: `${SUMMARY_MD}\n补充一行` },
    });
    expect(confirm.disabled).toBe(false);

    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    fireEvent.click(confirm);

    // 属性六字段默认值随载荷透传（assigneeId 缺省当前用户、日期空归一 null）
    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith({
        projectId: 11,
        title: "项目交接",
        description: `${SUMMARY_MD}\n补充一行`,
        source: "manual",
        status: "not_started",
        priority: "P1",
        tags: [],
        assigneeId: 3,
        startDate: null,
        dueDate: null,
      }),
    );
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["planItems", 11],
      }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["planItemsMine", 3],
    });
    expect(toastMock.success).toHaveBeenCalledWith("project:handover.created");
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    void client;
  });

  it("创建失败：toast 兜底，弹框不关闭", async () => {
    handoverMock.mockResolvedValue(SUMMARY_MD);
    const { onOpenChange } = renderDialog();
    fireEvent.change(await screen.findByLabelText("project:plan.title"), {
      target: { value: "项目交接" },
    });
    createMock.mockRejectedValueOnce(new Error("PLAN_ITEM_EXISTS"));
    fireEvent.click(screen.getByRole("button", { name: "common:confirm" }));

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledTimes(1));
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("属性胶囊：状态/处理人/标签/双日期改动进 create 载荷（日期 UTC 零点 ISO）", async () => {
    handoverMock.mockResolvedValue(SUMMARY_MD);
    renderDialog();

    // 状态：not_started → in_progress
    const statusPanel = await openCapsule("project:plan.status");
    fireEvent.click(
      within(statusPanel).getByRole("button", {
        name: "project:plan.statusInProgress",
      }),
    );

    // 处理人：缺省自己（id=3）→ 改派成员李四（id=8）
    const assigneePanel = await openCapsule("project:plan.handleMan");
    fireEvent.click(
      within(assigneePanel).getByRole("button", { name: "李四" }),
    );

    // 标签：回车添加
    const tagsPanel = await openCapsule("project:plan.tags");
    const tagInput = within(tagsPanel).getByLabelText("project:plan.tags");
    fireEvent.change(tagInput, { target: { value: "交接" } });
    fireEvent.keyDown(tagInput, { key: "Enter" });

    // 时间规划：开始 + 截止
    const timePanel = await openCapsule("project:plan.timeRange");
    fireEvent.change(
      within(timePanel).getByLabelText("project:plan.startDate"),
      { target: { value: "2026-09-28" } },
    );
    fireEvent.change(within(timePanel).getByLabelText("project:plan.dueDate"), {
      target: { value: "2026-10-15" },
    });

    fireEvent.change(screen.getByLabelText("project:plan.title"), {
      target: { value: "项目交接" },
    });
    fireEvent.click(screen.getByRole("button", { name: "common:confirm" }));

    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith({
        projectId: 11,
        title: "项目交接",
        description: SUMMARY_MD,
        source: "manual",
        status: "in_progress",
        priority: "P1",
        tags: ["交接"],
        assigneeId: 8,
        startDate: "2026-09-28T00:00:00.000Z",
        dueDate: "2026-10-15T00:00:00.000Z",
      }),
    );
  });

  it("附件：上传暂存 → 确认后按 create 返回 id 挂库", async () => {
    handoverMock.mockResolvedValue(SUMMARY_MD);
    const { onOpenChange } = renderDialog();
    await screen.findByLabelText("project:handover.summaryLabel");

    await uploadPendingAttachment("spec.pdf", "/tmp/spec.pdf");
    fireEvent.change(screen.getByLabelText("project:plan.title"), {
      target: { value: "项目交接" },
    });
    fireEvent.click(screen.getByRole("button", { name: "common:confirm" }));

    await waitFor(() =>
      expect(createAttachmentMock).toHaveBeenCalledWith(99, {
        fileName: "spec.pdf",
        assetPath: "attachments/spec.pdf",
      }),
    );
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith(
        "project:handover.created",
      ),
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("附件挂库失败：toast.attachFailed 但不阻断关闭", async () => {
    handoverMock.mockResolvedValue(SUMMARY_MD);
    const { onOpenChange } = renderDialog();
    await screen.findByLabelText("project:handover.summaryLabel");

    createAttachmentMock.mockRejectedValueOnce(new Error("ATTACH_FAIL"));
    await uploadPendingAttachment("spec.pdf", "/tmp/spec.pdf");
    fireEvent.change(screen.getByLabelText("project:plan.title"), {
      target: { value: "再次交接" },
    });
    fireEvent.click(screen.getByRole("button", { name: "common:confirm" }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("project:plan.attachFailed"),
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(toastMock.success).toHaveBeenCalledWith("project:handover.created");
  });
});

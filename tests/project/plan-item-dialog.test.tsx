// @vitest-environment jsdom
/**
 * PlanItemDialog / CustomFieldsEditor 测试（jsdom + testing-library，mock 骨架同
 * tests/project/create-project-dialog.test.tsx：t 返回 key、sonner、Radix 桩、
 * QueryClientProvider；PlanItemApi 八静态方法 + useUserStore 整体 mock，
 * 候选标签经 setQueryData(PLAN_ITEMS_KEY) 预置缓存）：
 * - 标题校验：空标题禁用提交（blur 后 titleRequired 提示）；超 100 字 titleTooLong
 * - 编辑模式：回填 title/status/priority/tags/customFields/description/处理人
 *   （成员昵称，经胶囊摘要断言）
 * - 描述（子系统 D）：textarea 输入 Markdown → 预览 MarkdownView 真实渲染
 *   （h1/ul-li）⇄ 编辑态切换值保留；create/update 携带 description（空串归
 *   null）
 * - 属性胶囊行（子系统 D）：五胶囊摘要规则（状态/优先级 = t(labelKey)、
 *   处理人 = 昵称/未指派、标签 = 首标签(+n)、时间 = `9.14 ~ 9.20` 双端/单端
 *   箭头/无值字段名）；Popover 内四态选项、成员列表（含未指派）、双 date
 *   Input、标签回车添加（trim/去重/清空输入）/X 移除/候选 chips 来自
 *   planItems 缓存 distinct 聚合（IME 组合回车不触发）；本地任务处理人只读
 *   『我』不可开且无时间胶囊
 * - 全屏模式（子系统 D）：maximize → DialogContent class 含 w-screen，再点
 *   还原；Esc 分层——全屏态仅退全屏（onOpenChange 不触发）、非全屏态照常关闭
 * - 自定义字段：text/number/date 三型 input type 断言；本地任务（projectId
 *   null）不渲染该区且不拉取字段定义
 * - 排期与处理人（三期子系统 A，子系统 D 胶囊化回归）：编辑回填日期（ISO
 *   前 10 位）/成员昵称；update 携带 ISO/null 与 assigneeId；显式「未指派」→
 *   create/update assigneeId null；编辑未指派事项回填「未指派」不回落当前
 *   用户（保存保留 null）；日期为 UTC 零点存储（dateKeyToIso）回往日历日不
 *   偏移；优先级含 P3
 * - defaultDueDate 预置（四期日历点格）：新建态时间胶囊内 dueDate 值 =
 *   预置日，提交 create 携带预置日 UTC 零点 ISO（与 defaultStatus 同构，
 *   编辑态忽略）
 * - 保存链路：create 参数完整（createdById/projectId/title/description/
 *   status/priority/tags/customFields，number 型转数字）；本地任务
 *   projectId/customFields 省略、无日期键；
 *   update 传全量字段；成功 invalidate planItems + planItemsMine 双 key +
 *   toast(plan:saved) + onSaved + 关闭；失败 toast.error 透传且弹窗保留
 * - CustomFieldsEditor：打开回填行、添加/删除/改名/改型、保存 saveFields +
 *   planFields/planItems 双失效 + toast + 关闭；空名/重名禁用保存
 * - AI 进展折叠区（子系统 F）：item.aiSummary 非空才渲染，默认收起、点开显
 *   pre-wrap 只读全文（恒 item 原值，人路径不可编辑）；空串不渲染
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

// Radix Select 在 jsdom 的最小桩：popper 定位依赖 ResizeObserver，
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

// mapIpcError 依赖 @/i18n 实例，最小桩避免拉起完整 i18n 栈
vi.mock("@/i18n", () => ({
  default: { t: (key: string) => key },
}));

// PlanItemApi 静态类 + 四个 query key 工厂整体 mock（key 形状与真实实现一致）
vi.mock("@/domains/project/api/plan-item.api", () => ({
  default: {
    list: vi.fn(),
    listMine: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    move: vi.fn(),
    listFields: vi.fn(),
    saveFields: vi.fn(),
    listAttachments: vi.fn(),
    createAttachment: vi.fn(),
    removeAttachment: vi.fn(),
  },
  PLAN_ITEMS_KEY: (projectId: number) => ["planItems", projectId],
  PLAN_ITEMS_MINE_KEY: (userId: number) => ["planItemsMine", userId],
  PLAN_FIELDS_KEY: (projectId: number) => ["planFields", projectId],
  PLAN_ITEM_ATTACHMENTS_KEY: (planItemId: number) => [
    "planItemAttachments",
    planItemId,
  ],
}));

// AssetApi 静态类整体 mock（附件上传链路 pickFiles/upload）
vi.mock("@/domains/project/api/asset.api", () => ({
  default: {
    pickFiles: vi.fn(),
    upload: vi.fn(),
  },
}));

vi.mock("@/domains/user/store/user.store", () => ({
  useUserStore: (selector?: (state: { user: { id: number } }) => unknown) =>
    selector ? selector({ user: { id: 1 } }) : { user: { id: 1 } },
}));

// ProjectApi.listMembers（处理人选择器成员源）整体 mock
vi.mock("@/domains/project/api/project.api", () => ({
  default: { listMembers: vi.fn() },
}));

import PlanItemDialog from "../../src-react/domains/project/components/PlanItemDialog";
import CustomFieldsEditor from "../../src-react/domains/project/components/CustomFieldsEditor";
import PlanItemApi, {
  PLAN_FIELDS_KEY,
  PLAN_ITEMS_KEY,
} from "@/domains/project/api/plan-item.api";
import ProjectApi from "@/domains/project/api/project.api";
import AssetApi from "@/domains/project/api/asset.api";
import type { ProjectMemberItem } from "../../../electron/domains/project/project.entity";
import type {
  PlanFieldDef,
  PlanItemAttachmentRecord,
  PlanItemRecord,
} from "../../../electron/domains/project/plan-item.entity";

const FIELD_DEFS: PlanFieldDef[] = [
  { name: "里程碑", type: "text" },
  { name: "预算", type: "number" },
  { name: "截止", type: "date" },
];

/** 处理人选择器成员源（成员 2 非当前用户，覆盖改派） */
const MEMBERS: ProjectMemberItem[] = [
  { userId: 1, nickname: "黄", username: "hjx", role: "owner" },
  { userId: 2, nickname: "小美", username: "meimei", role: "member" },
];

const makeItem = (overrides: Partial<PlanItemRecord> = {}): PlanItemRecord => ({
  id: 7,
  projectId: 1,
  title: "既有事项",
  description: "",
  aiSummary: "",
  status: "in_progress",
  priority: "P0",
  assigneeId: 1,
  tags: ["设计"],
  customFields: { 预算: 100 },
  startDate: "",
  dueDate: "",
  source: "manual",
  sortOrder: 1,
  createdById: 1,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  ...overrides,
});

/** 已挂附件关联记录（编辑态回填源） */
const makeAttachment = (
  overrides: Partial<PlanItemAttachmentRecord> = {},
): PlanItemAttachmentRecord => ({
  id: 5,
  planItemId: 7,
  fileName: "spec.pdf",
  assetPath: "attachments/spec.pdf",
  createdAt: "2026-09-01T00:00:00.000Z",
  ...overrides,
});

interface PlanDialogRenderProps {
  projectId?: number | null;
  item?: PlanItemRecord;
  cacheItems?: PlanItemRecord[];
  defaultDueDate?: string;
}

/** 渲染打开态事项弹窗（可预置 planItems 缓存供候选标签聚合） */
async function renderPlanDialog({
  projectId = 1,
  item,
  cacheItems,
  defaultDueDate,
}: PlanDialogRenderProps = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (cacheItems) {
    client.setQueryData(PLAN_ITEMS_KEY(projectId ?? -1), cacheItems);
  }
  const onSaved = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <PlanItemDialog
        open
        onOpenChange={onOpenChange}
        projectId={projectId}
        item={item}
        defaultDueDate={defaultDueDate}
        onSaved={onSaved}
      />
    </QueryClientProvider>,
  );
  await screen.findByRole("dialog");
  return { onSaved, onOpenChange };
}

/** 渲染打开态字段定义管理弹窗 */
async function renderFieldEditor() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <CustomFieldsEditor open onOpenChange={onOpenChange} projectId={1} />
    </QueryClientProvider>,
  );
  await screen.findByRole("dialog");
  return { onOpenChange };
}

/** Radix Select 选项切换：mouse pointerDown 展开 + click 选中 */
async function selectOption(trigger: HTMLElement, optionName: string) {
  fireEvent.pointerDown(trigger, {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
  fireEvent.click(await screen.findByRole("option", { name: optionName }));
}

const getTitleInput = () =>
  screen.getByLabelText("project:plan.title") as HTMLInputElement;
const getSaveButton = () =>
  screen.getByRole("button", { name: "common:save" }) as HTMLButtonElement;

/* ---------- 属性胶囊行（子系统 D）：触发按钮 + Popover 开合 ---------- */

const getStatusCapsule = () =>
  screen.getByRole("button", { name: "project:plan.status" });
const getPriorityCapsule = () =>
  screen.getByRole("button", { name: "project:plan.priority" });
const getAssigneeCapsule = () =>
  screen.getByRole("button", { name: "project:plan.handleMan" });
const getTagsCapsule = () =>
  screen.getByRole("button", { name: "project:plan.tags" });
const getTimeCapsule = () =>
  screen.getByRole("button", { name: "project:plan.timeRange" });
/** 描述输入框（编辑态 textarea；预览态不存在） */
const getDescriptionTextarea = () =>
  screen.getByLabelText("project:plan.description") as HTMLTextAreaElement;

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

/** 胶囊内点选选项（点击后胶囊收起） */
async function pickCapsuleOption(capsuleName: string, optionName: string) {
  const panel = await openCapsule(capsuleName);
  fireEvent.click(within(panel).getByRole("button", { name: optionName }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: capsuleName })).toBeNull(),
  );
}

beforeEach(() => {
  vi.mocked(PlanItemApi.listFields).mockReset().mockResolvedValue(FIELD_DEFS);
  vi.mocked(PlanItemApi.create).mockReset().mockResolvedValue(makeItem());
  vi.mocked(PlanItemApi.update).mockReset().mockResolvedValue(undefined);
  vi.mocked(PlanItemApi.saveFields).mockReset().mockResolvedValue(undefined);
  vi.mocked(PlanItemApi.listAttachments).mockReset().mockResolvedValue([]);
  vi.mocked(PlanItemApi.createAttachment)
    .mockReset()
    .mockResolvedValue(makeAttachment());
  vi.mocked(AssetApi.pickFiles).mockReset().mockResolvedValue(null);
  vi.mocked(AssetApi.upload).mockReset().mockResolvedValue({
    uploaded: [],
    failed: [],
  });
  vi.mocked(ProjectApi.listMembers).mockReset().mockResolvedValue(MEMBERS);
  toastMock.success.mockClear();
  toastMock.error.mockClear();
});

afterEach(cleanup);

describe("PlanItemDialog 标题校验", () => {
  it("空标题禁用提交，blur 后提示 titleRequired", async () => {
    await renderPlanDialog();
    expect(getSaveButton().disabled).toBe(true);
    fireEvent.blur(getTitleInput());
    expect(screen.getByText("project:plan.titleRequired")).toBeTruthy();
  });

  it("超过 100 字提示 titleTooLong 且禁用，改回合法恢复", async () => {
    await renderPlanDialog();
    fireEvent.change(getTitleInput(), { target: { value: "字".repeat(101) } });
    expect(screen.getByText("project:plan.titleTooLong")).toBeTruthy();
    expect(getSaveButton().disabled).toBe(true);
    expect(PlanItemApi.create).not.toHaveBeenCalled();

    fireEvent.change(getTitleInput(), { target: { value: "正常标题" } });
    expect(screen.queryByText("project:plan.titleTooLong")).toBeNull();
    expect(getSaveButton().disabled).toBe(false);
  });
});

describe("PlanItemDialog 编辑模式回填", () => {
  it("回填 title/status/priority/tags/customFields/description，处理人回填成员昵称", async () => {
    await renderPlanDialog({ item: makeItem() });
    expect(getTitleInput().value).toBe("既有事项");
    expect(getDescriptionTextarea().value).toBe("");
    // 属性胶囊摘要承载回填值（状态/优先级 = t(labelKey)）
    expect(getStatusCapsule().textContent).toContain(
      "project:plan.statusInProgress",
    );
    expect(getPriorityCapsule().textContent).toContain(
      "project:plan.priorityP0",
    );
    expect(getTagsCapsule().textContent).toContain("设计");
    // 处理人回填 assigneeId=1 对应成员昵称（成员列表异步到达）
    await waitFor(() =>
      expect(getAssigneeCapsule().textContent).toContain("黄"),
    );
    expect(
      ((await screen.findByLabelText("预算")) as HTMLInputElement).value,
    ).toBe("100");
    expect(PlanItemApi.create).not.toHaveBeenCalled();
  });
});

describe("PlanItemDialog 标签编辑", () => {
  it("回车添加（trim/去重/清空）+ X 移除 + 候选 chips 来自 planItems 缓存", async () => {
    await renderPlanDialog({
      cacheItems: [
        makeItem({ id: 1, tags: ["urgent", "design"] }),
        makeItem({ id: 2, tags: ["design", "bug"] }),
      ],
    });
    // 标签编辑迁入胶囊 Popover（子系统 D）
    const panel = await openCapsule("project:plan.tags");
    // 候选 = 缓存 distinct 聚合
    ["bug", "design", "urgent"].forEach((name) =>
      expect(within(panel).getByRole("button", { name })).toBeTruthy(),
    );

    // 回车添加：trim 后入列、输入清空
    const tagInput = within(panel).getByLabelText(
      "project:plan.tags",
    ) as HTMLInputElement;
    fireEvent.change(tagInput, { target: { value: " 新标签 " } });
    fireEvent.keyDown(tagInput, { key: "Enter" });
    expect(within(panel).getByText("新标签")).toBeTruthy();
    expect(tagInput.value).toBe("");

    // 重复输入已存在标签不重复添加
    fireEvent.change(tagInput, { target: { value: "新标签" } });
    fireEvent.keyDown(tagInput, { key: "Enter" });
    expect(within(panel).getAllByText("新标签")).toHaveLength(1);

    // 候选 chip 点击追加，选中后该候选隐藏
    fireEvent.click(within(panel).getByRole("button", { name: "design" }));
    expect(within(panel).getAllByText("design")).toHaveLength(1);
    expect(within(panel).queryByRole("button", { name: "design" })).toBeNull();

    // X 移除
    const chip = within(panel)
      .getByText("新标签")
      .closest("span") as HTMLElement;
    fireEvent.click(within(chip).getByRole("button", { name: "common:close" }));
    expect(within(panel).queryByText("新标签")).toBeNull();
  });
});

describe("PlanItemDialog 自定义字段", () => {
  it("按定义渲染 text/number/date 三型输入", async () => {
    await renderPlanDialog();
    expect(
      ((await screen.findByLabelText("里程碑")) as HTMLInputElement).type,
    ).toBe("text");
    expect((screen.getByLabelText("预算") as HTMLInputElement).type).toBe(
      "number",
    );
    expect((screen.getByLabelText("截止") as HTMLInputElement).type).toBe(
      "date",
    );
  });

  it("本地任务（projectId null）不渲染该区且不拉取字段定义", async () => {
    await renderPlanDialog({ projectId: null });
    expect(screen.queryByLabelText("里程碑")).toBeNull();
    expect(PlanItemApi.listFields).not.toHaveBeenCalled();
  });
});

describe("PlanItemDialog 保存链路", () => {
  it("新建：create 参数完整（number 型转数字）+ 双 key 失效 + toast + onSaved + 关闭", async () => {
    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    const { onSaved, onOpenChange } = await renderPlanDialog();
    fireEvent.change(getTitleInput(), { target: { value: "新事项" } });
    // 标签经胶囊 Popover 回车添加
    const tagsPanel = await openCapsule("project:plan.tags");
    const tagInput = within(tagsPanel).getByLabelText(
      "project:plan.tags",
    ) as HTMLInputElement;
    fireEvent.change(tagInput, { target: { value: "urgent" } });
    fireEvent.keyDown(tagInput, { key: "Enter" });
    fireEvent.change(await screen.findByLabelText("里程碑"), {
      target: { value: "v1" },
    });
    fireEvent.change(screen.getByLabelText("预算"), {
      target: { value: "100" },
    });
    await pickCapsuleOption("project:plan.status", "project:plan.statusDone");
    await pickCapsuleOption("project:plan.priority", "project:plan.priorityP2");

    fireEvent.click(getSaveButton());

    await waitFor(() => expect(PlanItemApi.create).toHaveBeenCalledTimes(1));
    expect(PlanItemApi.create).toHaveBeenCalledWith({
      createdById: 1,
      assigneeId: 1,
      projectId: 1,
      title: "新事项",
      description: null,
      status: "done",
      priority: "P2",
      tags: ["urgent"],
      customFields: { 里程碑: "v1", 预算: 100 },
      // 项目任务日期未填 → null（清空语义）
      startDate: null,
      dueDate: null,
    });
    expect(PlanItemApi.update).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["planItems", 1],
      }),
    );
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["planItemsMine", 1],
      }),
    );
    expect(toastMock.success).toHaveBeenCalledWith("project:plan.saved");
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    invalidateSpy.mockRestore();
  });

  it("本地任务新建：projectId 与空 customFields 省略，无日期键且处理人只读「我」", async () => {
    const { onSaved } = await renderPlanDialog({ projectId: null });
    // 本地任务：处理人只读「我」、无时间胶囊、不拉成员列表
    expect(getAssigneeCapsule().textContent).toContain("project:plan.me");
    expect(
      screen.queryByRole("button", { name: "project:plan.timeRange" }),
    ).toBeNull();
    expect(ProjectApi.listMembers).not.toHaveBeenCalled();
    fireEvent.change(getTitleInput(), { target: { value: "本地任务" } });
    fireEvent.click(getSaveButton());

    await waitFor(() => expect(PlanItemApi.create).toHaveBeenCalledTimes(1));
    expect(PlanItemApi.create).toHaveBeenCalledWith({
      createdById: 1,
      assigneeId: 1,
      title: "本地任务",
      description: null,
      status: "not_started",
      priority: "P1",
      tags: [],
      customFields: undefined,
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it("编辑：update 传全量字段 + 双 key 失效 + onSaved", async () => {
    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    const { onSaved } = await renderPlanDialog({ item: makeItem() });
    await screen.findByLabelText("预算");
    fireEvent.change(getTitleInput(), { target: { value: "改名后" } });
    fireEvent.change(screen.getByLabelText("预算"), {
      target: { value: "200" },
    });
    fireEvent.click(getSaveButton());

    await waitFor(() => expect(PlanItemApi.update).toHaveBeenCalledTimes(1));
    expect(PlanItemApi.update).toHaveBeenCalledWith({
      id: 7,
      title: "改名后",
      description: null,
      status: "in_progress",
      priority: "P0",
      tags: ["设计"],
      customFields: { 预算: 200 },
      assigneeId: 1,
      startDate: null,
      dueDate: null,
    });
    expect(PlanItemApi.create).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["planItems", 1],
      }),
    );
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["planItemsMine", 1],
      }),
    );
    expect(onSaved).toHaveBeenCalledTimes(1);
    invalidateSpy.mockRestore();
  });

  it("保存失败 → toast.error 透传，弹窗保留且 onSaved 不触发", async () => {
    vi.mocked(PlanItemApi.create).mockRejectedValueOnce(
      new Error("标题不能为空"),
    );
    const { onSaved, onOpenChange } = await renderPlanDialog();
    fireEvent.change(getTitleInput(), { target: { value: "新事项" } });
    fireEvent.click(getSaveButton());

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("标题不能为空"),
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe("PlanItemDialog 排期与处理人（三期子系统 A，子系统 D 胶囊化）", () => {
  it("编辑回填日期与处理人；提交 update 携带 ISO/null 与 assigneeId", async () => {
    await renderPlanDialog({
      item: makeItem({
        assigneeId: 2,
        startDate: "2026-09-01T00:00:00.000Z",
        dueDate: "",
      }),
    });
    // 处理人回填成员 2 昵称；开始日期回填 ISO 前 10 位，空截止 = 空框
    await waitFor(() =>
      expect(getAssigneeCapsule().textContent).toContain("小美"),
    );
    let timePanel = await openCapsule("project:plan.timeRange");
    expect(
      (
        within(timePanel).getByLabelText(
          "project:plan.startDate",
        ) as HTMLInputElement
      ).value,
    ).toBe("2026-09-01");
    expect(
      (
        within(timePanel).getByLabelText(
          "project:plan.dueDate",
        ) as HTMLInputElement
      ).value,
    ).toBe("");

    // 改派成员 1 + 改开始日期后保存
    await pickCapsuleOption("project:plan.handleMan", "黄");
    timePanel = await openCapsule("project:plan.timeRange");
    fireEvent.change(
      within(timePanel).getByLabelText("project:plan.startDate"),
      { target: { value: "2026-09-05" } },
    );
    fireEvent.click(getSaveButton());

    await waitFor(() => expect(PlanItemApi.update).toHaveBeenCalledTimes(1));
    expect(PlanItemApi.update).toHaveBeenCalledWith({
      id: 7,
      title: "既有事项",
      description: null,
      status: "in_progress",
      priority: "P0",
      tags: ["设计"],
      customFields: { 预算: 100 },
      assigneeId: 1,
      // 日期框「YYYY-MM-DD」→ UTC 零点 ISO；空截止 → null（清空）
      startDate: "2026-09-05T00:00:00.000Z",
      dueDate: null,
    });
    expect(ProjectApi.listMembers).toHaveBeenCalledWith(1);
  });

  it("日期时区往返：选 2026-09-14 → update 载荷 startDate 以 2026-09-14 开头", async () => {
    await renderPlanDialog({ item: makeItem({ assigneeId: 1 }) });
    const timePanel = await openCapsule("project:plan.timeRange");
    fireEvent.change(
      within(timePanel).getByLabelText("project:plan.startDate"),
      { target: { value: "2026-09-14" } },
    );
    fireEvent.click(getSaveButton());

    await waitFor(() => expect(PlanItemApi.update).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(PlanItemApi.update).mock.calls[0][0];
    // UTC 零点存储：任何时区下日历日不得偏移（UTC+8 曾偏成 09-13T16:00Z）
    expect(payload.startDate).toMatch(/^2026-09-14T00:00:00\.000Z$/);
  });

  it("处理人可改选「未指派」；编辑提交 update 携带 assigneeId null（清空指派）", async () => {
    await renderPlanDialog({ item: makeItem({ assigneeId: 2 }) });
    await waitFor(() =>
      expect(getAssigneeCapsule().textContent).toContain("小美"),
    );
    await pickCapsuleOption(
      "project:plan.handleMan",
      "project:plan.unassigned",
    );
    expect(getAssigneeCapsule().textContent).toContain(
      "project:plan.unassigned",
    );
    fireEvent.click(getSaveButton());

    await waitFor(() => expect(PlanItemApi.update).toHaveBeenCalledTimes(1));
    expect(PlanItemApi.update).toHaveBeenCalledWith(
      expect.objectContaining({ assigneeId: null }),
    );
  });

  it("编辑未指派事项：回填「未指派」不回落当前用户，保存保留 assigneeId null", async () => {
    await renderPlanDialog({ item: makeItem({ assigneeId: null }) });
    // ?? 缺陷回归：编辑打开 assigneeId null 曾被回落当前用户（显示「我」）
    await waitFor(() =>
      expect(getAssigneeCapsule().textContent).toContain(
        "project:plan.unassigned",
      ),
    );
    expect(getAssigneeCapsule().textContent).not.toContain("project:plan.me");

    fireEvent.change(getTitleInput(), { target: { value: "未指派事项" } });
    fireEvent.click(getSaveButton());

    await waitFor(() => expect(PlanItemApi.update).toHaveBeenCalledTimes(1));
    expect(PlanItemApi.update).toHaveBeenCalledWith(
      expect.objectContaining({ title: "未指派事项", assigneeId: null }),
    );
  });

  it("新建显式选「未指派」→ create 携带 assigneeId null（不被回落为当前用户）", async () => {
    await renderPlanDialog();
    // 打开缺省指派自己（成员 1），显式改选「未指派」后保存
    await waitFor(() =>
      expect(getAssigneeCapsule().textContent).toContain("黄"),
    );
    await pickCapsuleOption(
      "project:plan.handleMan",
      "project:plan.unassigned",
    );
    fireEvent.change(getTitleInput(), { target: { value: "无主事项" } });
    fireEvent.click(getSaveButton());

    await waitFor(() => expect(PlanItemApi.create).toHaveBeenCalledTimes(1));
    expect(PlanItemApi.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: "无主事项", assigneeId: null }),
    );
  });

  it("优先级胶囊含 P3；选 P3 提交 create 带 priority P3", async () => {
    await renderPlanDialog();
    fireEvent.change(getTitleInput(), { target: { value: "P3 事项" } });
    // 胶囊展开后 P3 选项可选（findByRole 隐含断言选项存在）
    await pickCapsuleOption("project:plan.priority", "project:plan.priorityP3");
    expect(getPriorityCapsule().textContent).toContain(
      "project:plan.priorityP3",
    );
    fireEvent.click(getSaveButton());

    await waitFor(() => expect(PlanItemApi.create).toHaveBeenCalledTimes(1));
    expect(PlanItemApi.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: "P3 事项", priority: "P3" }),
    );
  });
});

describe("PlanItemDialog defaultDueDate 预置（四期日历点格）", () => {
  it("新建态 dueDate Input 值 = 预置日；提交 create 携带预置日 UTC 零点 ISO", async () => {
    await renderPlanDialog({ defaultDueDate: "2026-09-20" });
    const timePanel = await openCapsule("project:plan.timeRange");
    expect(
      (
        within(timePanel).getByLabelText(
          "project:plan.dueDate",
        ) as HTMLInputElement
      ).value,
    ).toBe("2026-09-20");
    // 预置只作用于截止日，开始日不连带
    expect(
      (
        within(timePanel).getByLabelText(
          "project:plan.startDate",
        ) as HTMLInputElement
      ).value,
    ).toBe("");

    fireEvent.change(getTitleInput(), { target: { value: "日历预置事项" } });
    fireEvent.click(getSaveButton());

    await waitFor(() => expect(PlanItemApi.create).toHaveBeenCalledTimes(1));
    expect(PlanItemApi.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "日历预置事项",
        dueDate: "2026-09-20T00:00:00.000Z",
        startDate: null,
      }),
    );
  });

  it("编辑态忽略 defaultDueDate：回填 item 自身 dueDate", async () => {
    await renderPlanDialog({
      item: makeItem({
        dueDate: "2026-10-08T00:00:00.000Z",
      }),
      defaultDueDate: "2026-09-20",
    });
    const timePanel = await openCapsule("project:plan.timeRange");
    expect(
      (
        within(timePanel).getByLabelText(
          "project:plan.dueDate",
        ) as HTMLInputElement
      ).value,
    ).toBe("2026-10-08");
  });
});

describe("PlanItemDialog 描述与 Markdown 预览（子系统 D）", () => {
  it("输入 Markdown → 点『预览』出现 MarkdownView 渲染（标题/条目），再点回编辑态 textarea 值保留", async () => {
    await renderPlanDialog();
    fireEvent.change(getDescriptionTextarea(), {
      target: { value: "# 标题\n- 条目" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "project:plan.preview" }),
    );

    // 预览态：textarea 隐藏，MarkdownView 真实管道渲染 h1 + ul/li
    expect(screen.queryByLabelText("project:plan.description")).toBeNull();
    expect(
      screen.getByRole("heading", { level: 1, name: "标题" }),
    ).toBeTruthy();
    // listitem 非内容命名角色（ARIA），经列表容器内文本断言
    expect(within(screen.getByRole("list")).getByText("条目")).toBeTruthy();

    // 切回编辑态：textarea 值原样保留
    fireEvent.click(
      screen.getByRole("button", { name: "project:plan.editMode" }),
    );
    expect(getDescriptionTextarea().value).toBe("# 标题\n- 条目");
  });

  it("描述保存：create 携带 description 原文", async () => {
    await renderPlanDialog();
    fireEvent.change(getTitleInput(), { target: { value: "带描述事项" } });
    fireEvent.change(getDescriptionTextarea(), {
      target: { value: "# 目标\n- 拆解" },
    });
    fireEvent.click(getSaveButton());

    await waitFor(() => expect(PlanItemApi.create).toHaveBeenCalledTimes(1));
    expect(PlanItemApi.create).toHaveBeenCalledWith(
      expect.objectContaining({ description: "# 目标\n- 拆解" }),
    );
  });

  it("编辑回填描述；清空后 update 携带 description null（清空语义）", async () => {
    await renderPlanDialog({ item: makeItem({ description: "旧描述" }) });
    expect(getDescriptionTextarea().value).toBe("旧描述");
    fireEvent.change(getDescriptionTextarea(), { target: { value: "" } });
    fireEvent.click(getSaveButton());

    await waitFor(() => expect(PlanItemApi.update).toHaveBeenCalledTimes(1));
    expect(PlanItemApi.update).toHaveBeenCalledWith(
      expect.objectContaining({ description: null }),
    );
  });
});

describe("PlanItemDialog 属性胶囊行（子系统 D）", () => {
  it("五胶囊各显示当前值摘要（无值显示字段名）；状态胶囊点开四态选项，选中后摘要更新且收起", async () => {
    await renderPlanDialog({ item: makeItem({ tags: ["设计", "研发"] }) });
    // 摘要规则：状态/优先级 = t(labelKey)；处理人 = 昵称；标签 = 首标签(+n)；
    // 时间无值显示字段名（muted）
    expect(getStatusCapsule().textContent).toContain(
      "project:plan.statusInProgress",
    );
    expect(getPriorityCapsule().textContent).toContain(
      "project:plan.priorityP0",
    );
    expect(getTagsCapsule().textContent).toContain("设计(+1)");
    await waitFor(() =>
      expect(getAssigneeCapsule().textContent).toContain("黄"),
    );
    expect(getTimeCapsule().textContent).toContain("project:plan.timeRange");

    fireEvent.click(getStatusCapsule());
    const panel = await screen.findByRole("dialog", {
      name: "project:plan.status",
    });
    [
      "project:plan.statusNotStarted",
      "project:plan.statusInProgress",
      "project:plan.statusPaused",
      "project:plan.statusDone",
    ].forEach((optionName) =>
      expect(
        within(panel).getByRole("button", { name: optionName }),
      ).toBeTruthy(),
    );

    fireEvent.click(
      within(panel).getByRole("button", { name: "project:plan.statusDone" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "project:plan.status" }),
      ).toBeNull(),
    );
    expect(getStatusCapsule().textContent).toContain("project:plan.statusDone");
  });

  it("时间规划胶囊：Popover 内双 date Input，改截止日保存 payload dueDate 正确；摘要 `a ~ b`", async () => {
    await renderPlanDialog({
      item: makeItem({ startDate: "2026-09-14T00:00:00.000Z" }),
    });
    const panel = await openCapsule("project:plan.timeRange");
    expect(
      (
        within(panel).getByLabelText(
          "project:plan.startDate",
        ) as HTMLInputElement
      ).value,
    ).toBe("2026-09-14");
    expect(
      (within(panel).getByLabelText("project:plan.dueDate") as HTMLInputElement)
        .value,
    ).toBe("");

    fireEvent.change(within(panel).getByLabelText("project:plan.dueDate"), {
      target: { value: "2026-09-20" },
    });
    await waitFor(() =>
      expect(getTimeCapsule().textContent).toContain("9.14 ~ 9.20"),
    );

    fireEvent.click(getSaveButton());
    await waitFor(() => expect(PlanItemApi.update).toHaveBeenCalledTimes(1));
    expect(PlanItemApi.update).toHaveBeenCalledWith(
      expect.objectContaining({
        startDate: "2026-09-14T00:00:00.000Z",
        dueDate: "2026-09-20T00:00:00.000Z",
      }),
    );
  });

  it("处理人胶囊：项目任务 Popover 弹成员列表（含「未指派」）", async () => {
    await renderPlanDialog({ item: makeItem({ assigneeId: 2 }) });
    await waitFor(() =>
      expect(getAssigneeCapsule().textContent).toContain("小美"),
    );
    const panel = await openCapsule("project:plan.handleMan");
    ["project:plan.unassigned", "黄", "小美"].forEach((optionName) =>
      expect(
        within(panel).getByRole("button", { name: optionName }),
      ).toBeTruthy(),
    );
  });

  it("本地任务（projectId null）：处理人为只读触发按钮『我』且点击不开 Popover；无时间规划胶囊", async () => {
    await renderPlanDialog({ projectId: null });
    expect(getAssigneeCapsule().textContent).toContain("project:plan.me");
    fireEvent.click(getAssigneeCapsule());
    // 主弹窗仍在，但无以「处理人」命名的 Popover 弹出
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(
      screen.queryByRole("dialog", { name: "project:plan.handleMan" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "project:plan.timeRange" }),
    ).toBeNull();
  });
});

describe("PlanItemDialog 全屏模式（子系统 D）", () => {
  it("点右上按钮 → DialogContent class 含 w-screen；再点还原；Esc 全屏态仅退全屏、非全屏态关弹窗", async () => {
    const { onOpenChange } = await renderPlanDialog();
    expect(screen.getByRole("dialog").className).not.toContain("w-screen");

    fireEvent.click(
      screen.getByRole("button", { name: "project:plan.maximize" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("dialog").className).toContain("w-screen"),
    );

    // 全屏态 Esc：拦下 radix 关闭语义（onOpenChange 不触发），仅退全屏
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onOpenChange).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole("dialog").className).not.toContain("w-screen"),
    );

    // 再次全屏后按钮切换为「还原」，点击回到普通宽度
    fireEvent.click(
      screen.getByRole("button", { name: "project:plan.maximize" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("dialog").className).toContain("w-screen"),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "project:plan.restore" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("dialog").className).not.toContain("w-screen"),
    );

    // 非全屏态 Esc：正常关闭语义
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});

describe("PlanItemDialog 附件区（子系统 D）", () => {
  it("编辑态：listAttachments 回填 chips 文件名；保存不动已挂记录（createAttachment 不调用）", async () => {
    vi.mocked(PlanItemApi.listAttachments)
      .mockReset()
      .mockResolvedValue([makeAttachment()]);
    const { onSaved } = await renderPlanDialog({ item: makeItem() });
    expect(await screen.findByText("spec.pdf")).toBeTruthy();
    expect(PlanItemApi.listAttachments).toHaveBeenCalledWith(7);

    fireEvent.click(getSaveButton());
    await waitFor(() => expect(PlanItemApi.update).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(PlanItemApi.createAttachment).not.toHaveBeenCalled();
  });

  it("新建暂存→保存后批量挂：create 返回 id 逐条 createAttachment + 附件 key 失效 + 正常关闭", async () => {
    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    const { onSaved, onOpenChange } = await renderPlanDialog();
    fireEvent.change(getTitleInput(), { target: { value: "带附件事项" } });
    await uploadPendingAttachment("a.pdf", "/tmp/a.pdf");

    fireEvent.click(getSaveButton());
    await waitFor(() =>
      expect(PlanItemApi.createAttachment).toHaveBeenCalledWith(7, {
        fileName: "a.pdf",
        assetPath: "attachments/a.pdf",
      }),
    );
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["planItemAttachments", 7],
      }),
    );
    expect(toastMock.success).toHaveBeenCalledWith("project:plan.saved");
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    invalidateSpy.mockRestore();
  });

  it("编辑态新增暂存：update 后 createAttachment 携带 item.id（已挂记录不重复挂）", async () => {
    vi.mocked(PlanItemApi.listAttachments)
      .mockReset()
      .mockResolvedValue([makeAttachment()]);
    await renderPlanDialog({ item: makeItem() });
    await screen.findByText("spec.pdf");
    await uploadPendingAttachment("draft.md", "/tmp/draft.md");

    fireEvent.click(getSaveButton());
    await waitFor(() =>
      expect(PlanItemApi.createAttachment).toHaveBeenCalledTimes(1),
    );
    expect(PlanItemApi.createAttachment).toHaveBeenCalledWith(7, {
      fileName: "draft.md",
      assetPath: "attachments/draft.md",
    });
  });

  it("批量挂失败 → toast.error(attachFailed) 但不阻断关闭（onSaved + 关闭照常）", async () => {
    vi.mocked(PlanItemApi.createAttachment).mockRejectedValue(
      new Error("挂载失败"),
    );
    const { onSaved, onOpenChange } = await renderPlanDialog();
    fireEvent.change(getTitleInput(), { target: { value: "附件失败事项" } });
    await uploadPendingAttachment("a.pdf", "/tmp/a.pdf");

    fireEvent.click(getSaveButton());
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("project:plan.attachFailed"),
    );
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("本地任务（projectId null）：附件区不渲染（无回形针按钮）且不拉附件列表", async () => {
    await renderPlanDialog({ projectId: null });
    expect(
      screen.queryByRole("button", { name: "project:plan.attachments" }),
    ).toBeNull();
    expect(screen.queryByText("project:plan.attachments")).toBeNull();
    expect(PlanItemApi.listAttachments).not.toHaveBeenCalled();
  });
});

describe("CustomFieldsEditor 字段定义管理", () => {
  /** 编辑器用例统一回填单字段定义（与事项弹窗的三字段集区分） */
  beforeEach(() => {
    vi.mocked(PlanItemApi.listFields).mockResolvedValue([
      { name: "里程碑", type: "text" },
    ]);
  });

  it("回填行 + 添加/删除/改名/改型 + 保存 saveFields + 双失效 + toast + 关闭", async () => {
    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    const { onOpenChange } = await renderFieldEditor();
    const nameInputs = await screen.findAllByLabelText(
      "project:plan.fieldName",
    );
    expect(
      nameInputs.map((input) => (input as HTMLInputElement).value),
    ).toEqual(["里程碑"]);
    expect(
      screen.getAllByRole("combobox", { name: "project:plan.fieldType" })[0]
        .textContent,
    ).toContain("project:plan.fieldText");

    // 添加一行并填写名称
    fireEvent.click(
      screen.getByRole("button", { name: "project:plan.addField" }),
    );
    const inputs = screen.getAllByLabelText("project:plan.fieldName");
    expect(inputs).toHaveLength(2);
    fireEvent.change(inputs[1], { target: { value: "预算" } });

    // 再添加一行随即删除（删除链路）
    fireEvent.click(
      screen.getByRole("button", { name: "project:plan.addField" }),
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: "project:plan.delete" })[2],
    );
    expect(screen.getAllByLabelText("project:plan.fieldName")).toHaveLength(2);

    // 第一行类型 text → date
    await selectOption(
      screen.getAllByRole("combobox", { name: "project:plan.fieldType" })[0],
      "project:plan.fieldDate",
    );

    fireEvent.click(getSaveButton());
    await waitFor(() =>
      expect(PlanItemApi.saveFields).toHaveBeenCalledWith(1, [
        { name: "里程碑", type: "date" },
        { name: "预算", type: "text" },
      ]),
    );
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: PLAN_FIELDS_KEY(1),
      }),
    );
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: PLAN_ITEMS_KEY(1),
      }),
    );
    expect(toastMock.success).toHaveBeenCalledWith("project:plan.saved");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    invalidateSpy.mockRestore();
  });

  it("空名/重名禁用保存", async () => {
    await renderFieldEditor();
    const save = getSaveButton();
    await screen.findAllByLabelText("project:plan.fieldName");
    expect(save.disabled).toBe(false);

    fireEvent.click(
      screen.getByRole("button", { name: "project:plan.addField" }),
    );
    expect(save.disabled).toBe(true); // 新行空名

    const inputs = screen.getAllByLabelText("project:plan.fieldName");
    fireEvent.change(inputs[1], { target: { value: "里程碑" } });
    expect(save.disabled).toBe(true); // 与首行重名

    fireEvent.change(inputs[1], { target: { value: "预算" } });
    expect(save.disabled).toBe(false);
    expect(PlanItemApi.saveFields).not.toHaveBeenCalled();
  });
});

describe("PlanItemDialog AI 进展折叠区（子系统 F）", () => {
  const SUMMARY = "[2026-09-14] 启动\n[2026-09-15] 完成联调";

  /** 折叠区正文 p（textContent 全文精确匹配——多行文本规避 getByText 归一化） */
  const summaryBody = () =>
    screen.getByText(
      (_, element) =>
        element?.tagName === "P" && element.textContent === SUMMARY,
    );

  it("aiSummary 非空：头行渲染默认收起，点开显示 pre-wrap 全文", async () => {
    await renderPlanDialog({ item: makeItem({ aiSummary: SUMMARY }) });

    // 头行（Sparkles + 标签）渲染；默认收起无正文
    expect(screen.getByText("project:plan.aiSummary")).toBeTruthy();
    const toggle = screen.getByRole("button", {
      name: "project:plan.aiSummary",
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(
      screen.queryByText((_, element) => element?.tagName === "P"),
    ).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(summaryBody().className).toContain("whitespace-pre-wrap");
  });

  it("aiSummary 空 → 折叠区整块不渲染", async () => {
    await renderPlanDialog({ item: makeItem() });
    expect(screen.queryByText("project:plan.aiSummary")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "project:plan.aiSummary" }),
    ).toBeNull();
  });
});

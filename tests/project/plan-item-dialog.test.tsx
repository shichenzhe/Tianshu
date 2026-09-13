// @vitest-environment jsdom
/**
 * PlanItemDialog / CustomFieldsEditor 测试（jsdom + testing-library，mock 骨架同
 * tests/project/create-project-dialog.test.tsx：t 返回 key、sonner、Radix 桩、
 * QueryClientProvider；PlanItemApi 八静态方法 + useUserStore 整体 mock，
 * 候选标签经 setQueryData(PLAN_ITEMS_KEY) 预置缓存）：
 * - 标题校验：空标题禁用提交（blur 后 titleRequired 提示）；超 100 字 titleTooLong
 * - 编辑模式：回填 title/status/priority/tags/customFields/处理人（成员昵称）
 * - 标签：回车添加（trim/去重/清空输入）、X 移除、候选 chips 来自 planItems
 *   缓存 distinct 聚合、选中后候选隐藏
 * - 自定义字段：text/number/date 三型 input type 断言；本地任务（projectId
 *   null）不渲染该区且不拉取字段定义
 * - 排期与处理人（三期子系统 A）：编辑回填日期（ISO 前 10 位）/成员昵称；
 *   update 携带 ISO/null 与 assigneeId；日期区与成员 Select 仅项目任务
 *   （本地任务只读「我」、无日期框且 create 不带日期键）；日期为 UTC 零点
 *   存储、往返日历日不偏移；显式「未指派」→ create/update assigneeId null；
 *   优先级含 P3
 * - 保存链路：create 参数完整（createdById/projectId/title/status/priority/
 *   tags/customFields，number 型转数字）；本地任务 projectId/customFields 省略；
 *   update 传全量字段；成功 invalidate planItems + planItemsMine 双 key +
 *   toast(plan:saved) + onSaved + 关闭；失败 toast.error 透传且弹窗保留
 * - CustomFieldsEditor：打开回填行、添加/删除/改名/改型、保存 saveFields +
 *   planFields/planItems 双失效 + toast + 关闭；空名/重名禁用保存
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

// PlanItemApi 静态类 + 三个 query key 工厂整体 mock（key 形状与真实实现一致）
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
  },
  PLAN_ITEMS_KEY: (projectId: number) => ["planItems", projectId],
  PLAN_ITEMS_MINE_KEY: (userId: number) => ["planItemsMine", userId],
  PLAN_FIELDS_KEY: (projectId: number) => ["planFields", projectId],
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
import type { ProjectMemberItem } from "../../../electron/domains/project/project.entity";
import type {
  PlanFieldDef,
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
  status: "in_progress",
  priority: "P0",
  assigneeId: 1,
  tags: ["设计"],
  customFields: { 预算: 100 },
  sortOrder: 1,
  createdById: 1,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  ...overrides,
});

interface PlanDialogRenderProps {
  projectId?: number | null;
  item?: PlanItemRecord;
  cacheItems?: PlanItemRecord[];
}

/** 渲染打开态事项弹窗（可预置 planItems 缓存供候选标签聚合） */
async function renderPlanDialog({
  projectId = 1,
  item,
  cacheItems,
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
const getTagInput = () =>
  screen.getByLabelText("project:plan.tags") as HTMLInputElement;
/** 本地任务（projectId null）处理人只读框 */
const getAssigneeInput = () =>
  screen.getByLabelText("project:plan.handleMan") as HTMLInputElement;
/** 项目任务处理人成员 Select 触发器 */
const getAssigneeTrigger = () =>
  screen.getByRole("combobox", { name: "project:plan.handleMan" });
const getStartDateInput = () =>
  screen.getByLabelText("project:plan.startDate") as HTMLInputElement;
const getDueDateInput = () =>
  screen.getByLabelText("project:plan.dueDate") as HTMLInputElement;
const getStatusTrigger = () =>
  screen.getByRole("combobox", { name: "project:plan.status" });
const getPriorityTrigger = () =>
  screen.getByRole("combobox", { name: "project:plan.priority" });
const getSaveButton = () =>
  screen.getByRole("button", { name: "common:save" }) as HTMLButtonElement;

beforeEach(() => {
  vi.mocked(PlanItemApi.listFields).mockReset().mockResolvedValue(FIELD_DEFS);
  vi.mocked(PlanItemApi.create).mockReset().mockResolvedValue(makeItem());
  vi.mocked(PlanItemApi.update).mockReset().mockResolvedValue(undefined);
  vi.mocked(PlanItemApi.saveFields).mockReset().mockResolvedValue(undefined);
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
  it("回填 title/status/priority/tags/customFields，处理人回填成员昵称", async () => {
    await renderPlanDialog({ item: makeItem() });
    expect(getTitleInput().value).toBe("既有事项");
    expect(getStatusTrigger().textContent).toContain(
      "project:plan.statusInProgress",
    );
    expect(getPriorityTrigger().textContent).toContain(
      "project:plan.priorityP0",
    );
    expect(screen.getByText("设计")).toBeTruthy();
    // 处理人回填 assigneeId=1 对应成员昵称（成员列表异步到达）
    await waitFor(() =>
      expect(getAssigneeTrigger().textContent).toContain("黄"),
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
    // 候选 = 缓存 distinct 聚合
    expect(screen.getByRole("button", { name: "bug" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "design" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "urgent" })).toBeTruthy();

    // 回车添加：trim 后入列、输入清空
    const tagInput = getTagInput();
    fireEvent.change(tagInput, { target: { value: " 新标签 " } });
    fireEvent.keyDown(tagInput, { key: "Enter" });
    expect(screen.getByText("新标签")).toBeTruthy();
    expect(tagInput.value).toBe("");

    // 重复输入已存在标签不重复添加
    fireEvent.change(tagInput, { target: { value: "新标签" } });
    fireEvent.keyDown(tagInput, { key: "Enter" });
    expect(screen.getAllByText("新标签")).toHaveLength(1);

    // 候选 chip 点击追加，选中后该候选隐藏
    fireEvent.click(screen.getByRole("button", { name: "design" }));
    expect(screen.getAllByText("design")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "design" })).toBeNull();

    // X 移除
    const chip = screen.getByText("新标签").closest("span") as HTMLElement;
    fireEvent.click(within(chip).getByRole("button", { name: "common:close" }));
    expect(screen.queryByText("新标签")).toBeNull();
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
    fireEvent.change(getTagInput(), { target: { value: "urgent" } });
    fireEvent.keyDown(getTagInput(), { key: "Enter" });
    fireEvent.change(await screen.findByLabelText("里程碑"), {
      target: { value: "v1" },
    });
    fireEvent.change(screen.getByLabelText("预算"), {
      target: { value: "100" },
    });
    await selectOption(getStatusTrigger(), "project:plan.statusDone");
    await selectOption(getPriorityTrigger(), "project:plan.priorityP2");

    fireEvent.click(getSaveButton());

    await waitFor(() => expect(PlanItemApi.create).toHaveBeenCalledTimes(1));
    expect(PlanItemApi.create).toHaveBeenCalledWith({
      createdById: 1,
      assigneeId: 1,
      projectId: 1,
      title: "新事项",
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
    // 本地任务：处理人只读「我」、无日期框、不拉成员列表
    expect(getAssigneeInput().value).toBe("project:plan.me");
    expect(getAssigneeInput().readOnly).toBe(true);
    expect(screen.queryByLabelText("project:plan.startDate")).toBeNull();
    expect(screen.queryByLabelText("project:plan.dueDate")).toBeNull();
    expect(ProjectApi.listMembers).not.toHaveBeenCalled();
    fireEvent.change(getTitleInput(), { target: { value: "本地任务" } });
    fireEvent.click(getSaveButton());

    await waitFor(() => expect(PlanItemApi.create).toHaveBeenCalledTimes(1));
    expect(PlanItemApi.create).toHaveBeenCalledWith({
      createdById: 1,
      assigneeId: 1,
      title: "本地任务",
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

describe("PlanItemDialog 排期与处理人（三期子系统 A）", () => {
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
      expect(getAssigneeTrigger().textContent).toContain("小美"),
    );
    expect(getStartDateInput().value).toBe("2026-09-01");
    expect(getDueDateInput().value).toBe("");

    // 改派成员 1 + 改开始日期后保存
    await selectOption(getAssigneeTrigger(), "黄");
    fireEvent.change(getStartDateInput(), { target: { value: "2026-09-05" } });
    fireEvent.click(getSaveButton());

    await waitFor(() => expect(PlanItemApi.update).toHaveBeenCalledTimes(1));
    expect(PlanItemApi.update).toHaveBeenCalledWith({
      id: 7,
      title: "既有事项",
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
    fireEvent.change(getStartDateInput(), { target: { value: "2026-09-14" } });
    fireEvent.click(getSaveButton());

    await waitFor(() => expect(PlanItemApi.update).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(PlanItemApi.update).mock.calls[0][0];
    // UTC 零点存储：任何时区下日历日不得偏移（UTC+8 曾偏成 09-13T16:00Z）
    expect(payload.startDate).toMatch(/^2026-09-14T00:00:00\.000Z$/);
  });

  it("处理人可改选「未指派」；编辑提交 update 携带 assigneeId null（清空指派）", async () => {
    await renderPlanDialog({ item: makeItem({ assigneeId: 2 }) });
    await waitFor(() =>
      expect(getAssigneeTrigger().textContent).toContain("小美"),
    );
    await selectOption(getAssigneeTrigger(), "project:plan.unassigned");
    expect(getAssigneeTrigger().textContent).toContain(
      "project:plan.unassigned",
    );
    fireEvent.click(getSaveButton());

    await waitFor(() => expect(PlanItemApi.update).toHaveBeenCalledTimes(1));
    expect(PlanItemApi.update).toHaveBeenCalledWith(
      expect.objectContaining({ assigneeId: null }),
    );
  });

  it("新建显式选「未指派」→ create 携带 assigneeId null（不被回落为当前用户）", async () => {
    await renderPlanDialog();
    // 打开缺省指派自己（成员 1），显式改选「未指派」后保存
    await waitFor(() =>
      expect(getAssigneeTrigger().textContent).toContain("黄"),
    );
    await selectOption(getAssigneeTrigger(), "project:plan.unassigned");
    fireEvent.change(getTitleInput(), { target: { value: "无主事项" } });
    fireEvent.click(getSaveButton());

    await waitFor(() => expect(PlanItemApi.create).toHaveBeenCalledTimes(1));
    expect(PlanItemApi.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: "无主事项", assigneeId: null }),
    );
  });

  it("优先级下拉含 P3；选 P3 提交 create 带 priority P3", async () => {
    await renderPlanDialog();
    fireEvent.change(getTitleInput(), { target: { value: "P3 事项" } });
    // 下拉展开后 P3 选项可选（findByRole option 隐含断言选项存在）
    await selectOption(getPriorityTrigger(), "project:plan.priorityP3");
    expect(getPriorityTrigger().textContent).toContain(
      "project:plan.priorityP3",
    );
    fireEvent.click(getSaveButton());

    await waitFor(() => expect(PlanItemApi.create).toHaveBeenCalledTimes(1));
    expect(PlanItemApi.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: "P3 事项", priority: "P3" }),
    );
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

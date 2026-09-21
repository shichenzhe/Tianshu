// @vitest-environment jsdom
/**
 * CreateProjectDialog 新建项目弹窗测试（jsdom + testing-library，mock 骨架同
 * tests/project/picker-dialog.test.tsx + tests/ai/chat-view-edit-optimistic.test.tsx，
 * t 直接返回 key；ProjectApi/三能力 api/useUserStore 以模块级 mock 替代）：
 * - 模版覆盖确认状态机（spec §6.2 / PRD 4.1）：有内容切模版 → AlertDialog，
 *   确认覆盖 / 取消回弹（textarea 与 Select 各自保留）；空文本域直接填充
 * - 名称校验：空名称提交提示 nameRequired 且不发 IPC；超 15 字提示 nameTooLong
 * - 能力挂载：专家 PickerDialog 确认后 Tag 展示、可移除
 * - 提交链路：create 参数完整（ownerId/systemPrompt/templateKey/welcome/
 *   bindings）→ onCreated + 关闭；PROJECT_NAME_EXISTS → 内联提示不关弹窗；
 *   其他失败 → toast 且弹窗保留
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

vi.mock("@/domains/project/api/project.api", () => ({
  default: { create: vi.fn() },
}));
vi.mock("@/domains/ai/api/assistant.api", () => ({
  AssistantApi: { list: vi.fn() },
  default: { list: vi.fn() },
}));
vi.mock("@/domains/ai/skills/api/skill.api", () => ({
  default: { list: vi.fn() },
}));
vi.mock("@/domains/ai/api/mcp.api", () => ({
  McpServerApi: { list: vi.fn() },
  default: { list: vi.fn() },
}));
vi.mock("@/domains/user/store/user.store", () => ({
  useUserStore: (selector?: (state: { user: { id: number } }) => unknown) =>
    selector ? selector({ user: { id: 1 } }) : { user: { id: 1 } },
}));

import CreateProjectDialog from "../../src-react/domains/project/components/CreateProjectDialog";
import ProjectApi from "@/domains/project/api/project.api";
import { AssistantApi } from "@/domains/ai/api/assistant.api";
import type { AssistantRecord } from "@/domains/ai/api/assistant.api";
import SkillApi from "@/domains/ai/skills/api/skill.api";
import { McpServerApi } from "@/domains/ai/api/mcp.api";
import { getTemplate } from "../../src-react/domains/project/model/project-templates";
import type { McpServerRecord } from "@/domains/ai/api/mcp.api";
import type { SkillRecord } from "@/domains/ai/skills/api/skill.api";
import type { ProjectRecord } from "../../../electron/domains/project/project.entity";

const PRD = getTemplate("prd-workflow")!;
const MARKET = getTemplate("market-research")!;
const BLANK = getTemplate("blank")!;

const ASSISTANTS: AssistantRecord[] = [
  {
    id: 1,
    name: "专家A",
    systemPrompt: "写作专家",
    builtin: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  },
  {
    id: 2,
    name: "专家B",
    systemPrompt: "产品专家",
    builtin: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  },
];

const SKILLS: SkillRecord[] = [
  {
    id: 3,
    name: "联网搜索",
    slug: "web-search",
    version: "1.0.0",
    source: "hub",
    dir: "/skills/web-search",
    description: "搜索网页",
    enabled: true,
    installedAt: "2026-09-01T00:00:00.000Z",
  },
];

const MCP_SERVERS: McpServerRecord[] = [
  {
    id: 4,
    name: "github",
    transport: "http",
    url: "https://api.github.com",
    enabled: true,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  },
];

const CREATED: ProjectRecord = {
  id: 11,
  name: "alpha",
  systemPrompt: null,
  templateKey: null,
  ownerId: 1,
  sessionId: 21,
  createdAt: "2026-09-12T00:00:00.000Z",
  updatedAt: "2026-09-12T00:00:00.000Z",
};

/** 渲染打开态弹窗并冲刷挂载期 React Query 载入 */
async function renderDialog() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const onCreated = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <CreateProjectDialog
        open
        onOpenChange={onOpenChange}
        onCreated={onCreated}
      />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByRole("combobox")).toBeTruthy());
  return { onCreated, onOpenChange };
}

/** 展开模版下拉并点选指定模版（Radix Select：mouse pointerDown 开 + click 选） */
async function selectTemplate(templateName: string) {
  fireEvent.pointerDown(screen.getByRole("combobox"), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
  fireEvent.click(await screen.findByRole("option", { name: templateName }));
}

const getNameInput = () =>
  screen.getByPlaceholderText(
    "project:create.namePlaceholder",
  ) as HTMLInputElement;

const getTextarea = () =>
  screen.getByPlaceholderText(
    "project:create.promptPlaceholder",
  ) as HTMLTextAreaElement;

const getExpertsRegion = () =>
  screen.getByRole("region", { name: "project:create.experts" });

/** 覆盖确认 AlertDialog（role=alertdialog）内按钮 */
const getAlertButton = (name: string) =>
  within(screen.getByRole("alertdialog")).getByRole("button", { name });

beforeEach(() => {
  vi.mocked(ProjectApi.create).mockReset().mockResolvedValue(CREATED);
  vi.mocked(AssistantApi.list).mockReset().mockResolvedValue(ASSISTANTS);
  vi.mocked(SkillApi.list).mockReset().mockResolvedValue(SKILLS);
  vi.mocked(McpServerApi.list).mockReset().mockResolvedValue(MCP_SERVERS);
  toastMock.success.mockClear();
  toastMock.error.mockClear();
});

afterEach(cleanup);

describe("模版覆盖确认（spec 4.1 状态机）", () => {
  it("文本域已有内容时切模版 → 确认弹层出现；确认后填充新模版 prompt", async () => {
    await renderDialog();
    await selectTemplate(PRD.name);
    await waitFor(() => expect(getTextarea().value).toBe(PRD.prompt));

    fireEvent.change(getTextarea(), { target: { value: "手动编辑的指令" } });

    await selectTemplate(MARKET.name);
    // 确认弹层出现，且未确认前 textarea 不被覆盖
    expect(screen.getByText("project:create.overwriteTitle")).toBeTruthy();
    expect(screen.getByText("project:create.overwriteDesc")).toBeTruthy();
    expect(getTextarea().value).toBe("手动编辑的指令");

    fireEvent.click(getAlertButton("project:create.overwriteConfirm"));
    await waitFor(() => expect(getTextarea().value).toBe(MARKET.prompt));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("取消切换 → textarea 保持手动编辑内容，下拉回弹为原模版", async () => {
    await renderDialog();
    await selectTemplate(PRD.name);
    await waitFor(() => expect(getTextarea().value).toBe(PRD.prompt));
    fireEvent.change(getTextarea(), { target: { value: "手动编辑的指令" } });

    await selectTemplate(MARKET.name);
    fireEvent.click(getAlertButton("common:cancel"));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    expect(getTextarea().value).toBe("手动编辑的指令");
    expect(screen.getByRole("combobox").textContent).toContain(PRD.name);
  });

  it("文本域为空时切模版 → 直接填充，无确认弹层", async () => {
    await renderDialog();
    expect(getTextarea().value).toBe("");

    await selectTemplate(MARKET.name);

    await waitFor(() => expect(getTextarea().value).toBe(MARKET.prompt));
    expect(screen.queryByText("project:create.overwriteDesc")).toBeNull();
  });

  it("手动输入内容后切模版（无先前模版）→ 同样需要确认", async () => {
    await renderDialog();
    fireEvent.change(getTextarea(), { target: { value: "手写指令" } });

    await selectTemplate(MARKET.name);
    expect(screen.getByText("project:create.overwriteDesc")).toBeTruthy();
    fireEvent.click(getAlertButton("project:create.overwriteConfirm"));
    await waitFor(() => expect(getTextarea().value).toBe(MARKET.prompt));
  });
});

describe("名称校验", () => {
  it("空名称提交 → 显示 nameRequired，不调用 ProjectApi.create", async () => {
    const { onCreated } = await renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "common:confirm" }));
    expect(screen.getByText("project:create.nameRequired")).toBeTruthy();
    expect(vi.mocked(ProjectApi.create)).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("超过 15 字输入 → 实时显示 nameTooLong 且不提交", async () => {
    await renderDialog();
    fireEvent.change(getNameInput(), {
      target: { value: "一二三四五六七八九十一二三四五六" }, // 16 字
    });
    expect(screen.getByText("project:create.nameTooLong")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "common:confirm" }));
    expect(vi.mocked(ProjectApi.create)).not.toHaveBeenCalled();
  });
});

describe("能力挂载", () => {
  it("专家 PickerDialog 确认后以 Tag 展示，点击 X 可移除", async () => {
    await renderDialog();
    const region = getExpertsRegion();
    fireEvent.click(
      within(region).getByRole("button", { name: "project:create.add" }),
    );

    const picker = await screen.findByRole("dialog", {
      name: "project:create.experts",
    });
    fireEvent.click(within(picker).getByText("专家A"));
    fireEvent.click(
      within(picker).getByRole("button", { name: "project:picker.confirm" }),
    );

    await waitFor(() => expect(within(region).getByText("专家A")).toBeTruthy());
    fireEvent.click(
      within(region).getByRole("button", { name: "common:close" }),
    );
    expect(within(region).queryByText("专家A")).toBeNull();
  });
});

describe("提交链路", () => {
  it("成功 → create 参数完整，onCreated 回调、toast 并关闭弹窗", async () => {
    const { onCreated, onOpenChange } = await renderDialog();
    fireEvent.change(getNameInput(), { target: { value: "alpha" } });
    await selectTemplate(PRD.name);
    await waitFor(() => expect(getTextarea().value).toBe(PRD.prompt));

    // 挂载一个专家
    const region = getExpertsRegion();
    fireEvent.click(
      within(region).getByRole("button", { name: "project:create.add" }),
    );
    const picker = await screen.findByRole("dialog", {
      name: "project:create.experts",
    });
    fireEvent.click(within(picker).getByText("专家A"));
    fireEvent.click(
      within(picker).getByRole("button", { name: "project:picker.confirm" }),
    );
    await waitFor(() => expect(within(region).getByText("专家A")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "common:confirm" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(vi.mocked(ProjectApi.create)).toHaveBeenCalledWith({
      // ownerId 不再由前端传（v12 token 注入主进程解 userId）
      name: "alpha",
      systemPrompt: PRD.prompt,
      templateKey: "prd-workflow",
      welcomeMessage: PRD.welcome,
      bindings: [{ itemType: "assistant", itemId: 1 }],
    });
    expect(onCreated).toHaveBeenCalledWith(CREATED);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toastMock.success).toHaveBeenCalledWith("project:toast.created");
  });

  it("空白模版创建 → systemPrompt 省略，welcome 取空白模版文案", async () => {
    const { onCreated } = await renderDialog();
    fireEvent.change(getNameInput(), { target: { value: "beta" } });
    await selectTemplate(BLANK.name);
    await waitFor(() => expect(getTextarea().value).toBe(""));

    fireEvent.click(screen.getByRole("button", { name: "common:confirm" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(vi.mocked(ProjectApi.create)).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "beta",
        systemPrompt: undefined,
        templateKey: "blank",
        welcomeMessage: BLANK.welcome,
      }),
    );
  });

  it("未选模版 → templateKey/welcomeMessage 省略", async () => {
    const { onCreated } = await renderDialog();
    fireEvent.change(getNameInput(), { target: { value: "gamma" } });
    fireEvent.click(screen.getByRole("button", { name: "common:confirm" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(vi.mocked(ProjectApi.create)).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "gamma",
        systemPrompt: undefined,
        templateKey: undefined,
        welcomeMessage: undefined,
        bindings: [],
      }),
    );
  });

  it("重名失败 → 内联 nameExists，弹窗保持打开且内容保留", async () => {
    vi.mocked(ProjectApi.create).mockRejectedValueOnce(
      new Error("PROJECT_NAME_EXISTS"),
    );
    const { onCreated, onOpenChange } = await renderDialog();
    fireEvent.change(getNameInput(), { target: { value: "alpha" } });
    fireEvent.change(getTextarea(), { target: { value: "手动指令" } });
    fireEvent.click(screen.getByRole("button", { name: "common:confirm" }));

    await waitFor(() =>
      expect(screen.getByText("project:create.nameExists")).toBeTruthy(),
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(onCreated).not.toHaveBeenCalled();
    expect(toastMock.error).not.toHaveBeenCalled();
    expect(getNameInput().value).toBe("alpha");
    expect(getTextarea().value).toBe("手动指令");
  });

  it("其他创建失败 → toast 报错，弹窗不关闭", async () => {
    vi.mocked(ProjectApi.create).mockRejectedValueOnce(new Error("ipc broken"));
    const { onCreated, onOpenChange } = await renderDialog();
    fireEvent.change(getNameInput(), { target: { value: "alpha" } });
    fireEvent.click(screen.getByRole("button", { name: "common:confirm" }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        "project:toast.createFailed",
      ),
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.queryByText("project:create.nameExists")).toBeNull();
  });
});

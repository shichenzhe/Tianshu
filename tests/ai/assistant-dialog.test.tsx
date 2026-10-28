// @vitest-environment jsdom
/**
 * AssistantDialog 表单扩展（专家 2.0 Task 6）：
 * - 渲染四新字段（职业头衔/分类/推荐提示词/附带技能），附带技能胶囊来自
 *   已安装技能清单（SkillApi.list → skillRecords，数据源取 name 字段）
 * - 编辑态回填：profession 进输入框、quickPrompts 回填并补空行至 3 行、
 *   分类回显、原 skillNames 胶囊选中态
 * - 提交：quickPrompts 行文本 trim 后进 create 参数数组、空行剔除；
 *   分类留「不限」不传 categoryId
 * - 更新差量：未变字段 undefined（不提交）、取消全部技能 → null（清空）
 * - diffArrayInput 单元语义（一致 undefined / 空 null / 否则新数组）
 * - 专家团二期 Task 5：类型切换显隐成员区（默认 agent）、成员行增删与
 *   ≤13 上限、提交载荷（team 态 expertType+members、空 id 阻止并 toast、
 *   agent 新建不传、编辑转回 agent 清成员、agent 原无成员 undefined）
 * mock 骨架同 tests/ai/chat-input-todo.test.tsx：i18n 直返 key、
 * @/lib/ipc invoke 按通道分流（skill:list → 技能清单），断言走
 * invoke("assistant:create"/"assistant:update", params)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";

// localStorage stub：keybindings 等模块加载即读取，Node 环境原生全局
// 会打 ExperimentalWarning，先行替换为内存 stub 消除噪音
vi.hoisted(() => {
  const memory = new Map<string, string>();
  const stub = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
    clear: () => memory.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: stub,
    configurable: true,
    writable: true,
  });
});

// i18n mock：t 直接返回 key（断言不依赖具体文案）
vi.mock("@/i18n", () => ({
  default: { t: (key: string) => key },
}));
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

// IPC mock：skill:list 返回已安装技能清单（name 为表单数据源）；写通道成功
const invoke = vi.hoisted(() =>
  vi.fn((channel: string) => {
    if (channel === "skill:list") {
      return Promise.resolve([
        { id: 1, name: "pdf-export", enabled: false },
        { id: 2, name: "code-review", enabled: true },
      ]);
    }
    return Promise.resolve({ id: 9 });
  }),
);
vi.mock("@/lib/ipc", () => ({ invoke }));

// Radix Select 触发器 pointerDown 分支依赖 hasPointerCapture/scrollIntoView
// （tests/ai/model-dialog.test.tsx 先例）
window.HTMLElement.prototype.scrollIntoView = () => {};
window.HTMLElement.prototype.hasPointerCapture = () => false;

import AssistantDialog from "../../src-react/domains/ai/assistant/components/AssistantDialog";
import type { AssistantRecord } from "../../src-react/domains/ai/api/assistant.api";
import { diffArrayInput } from "../../src-react/domains/ai/lib/update-diff";

const editingRecord = {
  id: 5,
  name: "架构师",
  systemPrompt: "你是架构师",
  builtin: false,
  profession: "软件架构师",
  categoryId: "02-Engineering",
  quickPrompts: ["帮我评审这段代码"],
  skillNames: ["code-review"],
  createdAt: "",
  updatedAt: "",
} as AssistantRecord;

function renderDialog(editing?: AssistantRecord) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AssistantDialog open onOpenChange={() => {}} editing={editing} />
    </QueryClientProvider>,
  );
}

/** 取 Label 所在字段块内的输入框（结构：<div><Label/><Input/></div>） */
function fieldInputs(labelKey: string): HTMLInputElement[] {
  const box = screen.getByText(labelKey).parentElement!;
  return Array.from(box.querySelectorAll("input"));
}

/** 取 Label 所在字段块内的文本域 */
function fieldTextarea(labelKey: string): HTMLTextAreaElement {
  const box = screen.getByText(labelKey).parentElement!;
  return box.querySelector("textarea")!;
}

/** 点确定提交表单 */
function submit() {
  fireEvent.click(screen.getByRole("button", { name: "common:confirm" }));
}

describe("AssistantDialog 四新字段渲染", () => {
  afterEach(cleanup);
  beforeEach(() => vi.clearAllMocks());

  it("渲染职业头衔/分类/推荐提示词/附带技能标签", () => {
    renderDialog();
    expect(screen.getByText("ai:assistant.profession")).toBeTruthy();
    expect(screen.getByText("ai:assistant.category")).toBeTruthy();
    expect(screen.getByText("ai:assistant.quickPrompts")).toBeTruthy();
    expect(screen.getByText("ai:assistant.attachedSkills")).toBeTruthy();
  });

  it("附带技能胶囊来自已安装技能清单（name 字段，未按 enabled 过滤）", async () => {
    renderDialog();
    expect(
      await screen.findByRole("button", { name: "code-review" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "pdf-export" })).toBeTruthy();
  });

  it("无已安装技能时渲染提示行", async () => {
    invoke.mockImplementationOnce((channel: string) =>
      Promise.resolve(channel === "skill:list" ? [] : { id: 9 }),
    );
    renderDialog();
    await waitFor(() => {
      expect(screen.getByText("ai:assistant.noSkills")).toBeTruthy();
    });
  });
});

describe("AssistantDialog 编辑态回填", () => {
  afterEach(cleanup);
  beforeEach(() => vi.clearAllMocks());

  it("profession/quickPrompts/分类/附带技能选中态回显", async () => {
    renderDialog(editingRecord);
    expect(fieldInputs("ai:assistant.profession")[0].value).toBe("软件架构师");
    // 回填既有 1 条并补空行至 3 行
    expect(
      fieldInputs("ai:assistant.quickPrompts").map((r) => r.value),
    ).toEqual(["帮我评审这段代码", "", ""]);
    // 分类回显（Select 触发器展示选中项文案）
    expect(screen.getByRole("combobox").textContent).toContain(
      "chat:experts.categories.engineering",
    );
    // 原附带技能胶囊选中态（胶囊经 useQuery 异步就绪）
    const pill = await screen.findByRole("button", { name: "code-review" });
    expect(pill.className).toContain("bg-primary-subtle");
  });
});

describe("AssistantDialog 提交", () => {
  afterEach(cleanup);
  beforeEach(() => vi.clearAllMocks());

  it("create：quickPrompts 行文本进参数数组、空行剔除、留空字段不传", async () => {
    renderDialog();
    fireEvent.change(fieldInputs("ai:assistant.name")[0], {
      target: { value: "新专家" },
    });
    fireEvent.change(fieldTextarea("ai:assistant.systemPrompt"), {
      target: { value: "你是新专家" },
    });
    fireEvent.change(fieldInputs("ai:assistant.profession")[0], {
      target: { value: "软件架构师" },
    });
    const rows = fieldInputs("ai:assistant.quickPrompts");
    fireEvent.change(rows[0], { target: { value: "  帮我设计系统架构  " } });
    fireEvent.change(rows[1], { target: { value: "   " } });
    fireEvent.click(await screen.findByRole("button", { name: "code-review" }));
    submit();
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "assistant:create",
        expect.objectContaining({
          name: "新专家",
          profession: "软件架构师",
          quickPrompts: ["帮我设计系统架构"],
          skillNames: ["code-review"],
        }),
      );
    });
    // 分类留「不限」：categoryId 为 undefined（不设置）
    const createArgs = invoke.mock.calls.find(
      (call) => call[0] === "assistant:create",
    )![1];
    expect(createArgs.categoryId).toBeUndefined();
  });

  it("update：未变字段差量为 undefined、取消全部技能 → null", async () => {
    renderDialog(editingRecord);
    fireEvent.change(fieldInputs("ai:assistant.name")[0], {
      target: { value: "架构师" },
    });
    // 取消唯一附带技能 → 清空（胶囊经 useQuery 异步就绪）
    fireEvent.click(await screen.findByRole("button", { name: "code-review" }));
    submit();
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "assistant:update",
        expect.objectContaining({
          id: 5,
          profession: undefined,
          categoryId: undefined,
          quickPrompts: undefined,
          skillNames: null,
        }),
      );
    });
  });
});

describe("AssistantDialog 专家团类型切换与成员编辑", () => {
  afterEach(cleanup);
  beforeEach(() => vi.clearAllMocks());

  const teamRecord = {
    id: 7,
    name: "评审团",
    systemPrompt: "你是主理人",
    builtin: false,
    profession: "首席评审",
    expertType: "team",
    members: [
      {
        id: "risk-officer",
        name: "严守仓",
        profession: "风控官",
        systemPrompt: "你是风控官。",
      },
    ],
    createdAt: "",
    updatedAt: "",
  } as AssistantRecord;

  function switchType(buttonName: string) {
    fireEvent.click(screen.getByRole("button", { name: buttonName }));
  }

  function addMemberRow() {
    fireEvent.click(
      screen.getByRole("button", { name: "ai:assistant.addMember" }),
    );
  }

  /** 填第 index 行成员四字段（Label htmlFor/id 关联，getByLabelText 定位） */
  function fillMemberRow(
    index: number,
    member: { name: string; id: string; profession: string; prompt: string },
  ) {
    fireEvent.change(
      screen.getAllByLabelText("ai:assistant.memberName")[index],
      {
        target: { value: member.name },
      },
    );
    fireEvent.change(screen.getAllByLabelText("ai:assistant.memberId")[index], {
      target: { value: member.id },
    });
    fireEvent.change(
      screen.getAllByLabelText("ai:assistant.memberProfession")[index],
      { target: { value: member.profession } },
    );
    fireEvent.change(
      screen.getAllByLabelText("ai:assistant.memberPrompt")[index],
      { target: { value: member.prompt } },
    );
  }

  /** 填 name/systemPrompt 必填字段 */
  function fillExpertBasics() {
    fireEvent.change(fieldInputs("ai:assistant.name")[0], {
      target: { value: "评审团" },
    });
    fireEvent.change(fieldTextarea("ai:assistant.systemPrompt"), {
      target: { value: "你是主理人" },
    });
  }

  it("默认单专家无成员区；切换专家团显隐成员区", () => {
    renderDialog();
    expect(screen.queryByText("ai:assistant.membersTitle")).toBeNull();
    switchType("ai:assistant.typeTeam");
    expect(screen.getByText("ai:assistant.membersTitle")).toBeTruthy();
    switchType("ai:assistant.typeAgent");
    expect(screen.queryByText("ai:assistant.membersTitle")).toBeNull();
  });

  it("成员增删：两行删首行后提交仅剩次行", async () => {
    renderDialog();
    switchType("ai:assistant.typeTeam");
    addMemberRow();
    addMemberRow();
    fillMemberRow(0, {
      name: "严守仓",
      id: "risk-officer",
      profession: "风控官",
      prompt: "你是风控官。",
    });
    fillMemberRow(1, {
      name: "沈慎言",
      id: "compliance",
      profession: "合规官",
      prompt: "你是合规官。",
    });
    fireEvent.click(
      screen.getAllByRole("button", { name: "common:delete" })[0],
    );
    expect(screen.getAllByLabelText("ai:assistant.memberName")).toHaveLength(1);
    expect(screen.getAllByLabelText("ai:assistant.memberId")[0]).toHaveProperty(
      "value",
      "compliance",
    );
    fillExpertBasics();
    submit();
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "assistant:create",
        expect.objectContaining({
          expertType: "team",
          members: [
            {
              id: "compliance",
              name: "沈慎言",
              profession: "合规官",
              systemPrompt: "你是合规官。",
            },
          ],
        }),
      );
    });
  });

  it("成员行上限 13：满员后添加按钮不可再加", () => {
    renderDialog();
    switchType("ai:assistant.typeTeam");
    for (let i = 0; i < 14; i += 1) {
      addMemberRow();
    }
    expect(screen.getAllByLabelText("ai:assistant.memberName")).toHaveLength(
      13,
    );
    expect(
      (
        screen.getByRole("button", {
          name: "ai:assistant.addMember",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("空成员 id 阻止提交并 toast 提示", () => {
    renderDialog();
    switchType("ai:assistant.typeTeam");
    addMemberRow();
    fillExpertBasics();
    // id 只填空白（trim 后为空即视为未填）
    fillMemberRow(0, {
      name: "严守仓",
      id: "   ",
      profession: "风控官",
      prompt: "你是风控官。",
    });
    submit();
    expect(toast.error).toHaveBeenCalledWith("ai:assistant.needMemberId");
    expect(invoke).not.toHaveBeenCalledWith(
      "assistant:create",
      expect.anything(),
    );
  });

  it("team 态 0 成员提交被阻止（T5-M2：空团队无调度目标）", () => {
    renderDialog();
    switchType("ai:assistant.typeTeam");
    fillExpertBasics();
    expect(screen.queryAllByLabelText("ai:assistant.memberName")).toHaveLength(
      0,
    );
    submit();
    expect(toast.error).toHaveBeenCalledWith("ai:assistant.needMember");
    expect(invoke).not.toHaveBeenCalledWith(
      "assistant:create",
      expect.anything(),
    );
  });

  it("新建 agent 态不传 expertType/members", async () => {
    renderDialog();
    switchType("ai:assistant.typeTeam");
    switchType("ai:assistant.typeAgent");
    fillExpertBasics();
    submit();
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "assistant:create",
        expect.objectContaining({ name: "评审团" }),
      );
    });
    const createArgs = invoke.mock.calls.find(
      (call) => call[0] === "assistant:create",
    )![1];
    expect(createArgs.expertType).toBeUndefined();
    expect(createArgs.members).toBeUndefined();
  });

  it("编辑回填 team 记录：类型与成员字段回显，update 透传 expertType+members", async () => {
    renderDialog(teamRecord);
    expect(screen.getByText("ai:assistant.membersTitle")).toBeTruthy();
    expect(screen.getAllByLabelText("ai:assistant.memberId")[0]).toHaveProperty(
      "value",
      "risk-officer",
    );
    expect(
      screen.getAllByLabelText("ai:assistant.memberName")[0],
    ).toHaveProperty("value", "严守仓");
    submit();
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "assistant:update",
        expect.objectContaining({
          id: 7,
          expertType: "team",
          members: teamRecord.members,
        }),
      );
    });
  });

  it("编辑 team 转回 agent：expertType=agent 且 members=null（清列）", async () => {
    renderDialog(teamRecord);
    switchType("ai:assistant.typeAgent");
    fillExpertBasics();
    submit();
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "assistant:update",
        expect.objectContaining({
          expertType: "agent",
          members: null,
        }),
      );
    });
  });

  it("编辑 agent 记录（原无成员）：members 差量为 undefined", async () => {
    renderDialog(editingRecord);
    submit();
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "assistant:update",
        expect.objectContaining({ expertType: "agent" }),
      );
    });
    const updateArgs = invoke.mock.calls.find(
      (call) => call[0] === "assistant:update",
    )![1];
    expect(updateArgs.members).toBeUndefined();
  });
});

describe("diffArrayInput 差量语义", () => {
  it("一致 undefined / 清空 null / 否则新数组", () => {
    expect(diffArrayInput(["a"], ["a"])).toBeUndefined();
    expect(diffArrayInput([], ["a"])).toBeNull();
    expect(diffArrayInput(["a", "b"], ["a"])).toEqual(["a", "b"]);
    expect(diffArrayInput(["a"], undefined)).toEqual(["a"]);
    // 元素含逗号不干扰比较（连接符为分隔位字符）
    expect(diffArrayInput(["a,b"], ["a,b"])).toBeUndefined();
  });
});

// @vitest-environment jsdom
/**
 * SkillSubMenu 组件测试（引用选择器语义，2026-10-30 裁定：+ 菜单技能
 * 子菜单从全局启停浮层改为引用选择器）：
 * - 仅渲染已启用技能（禁用技能隐藏——启停收口管理页）
 * - 点击技能调 onToggleSkill(name) 回调（宿主接线 ⚡token/pending pill），
 *   不再调 skill:setEnabled IPC
 * - referencedSkills 匹配项勾选 Check（引用态依据）
 * - 无启用技能时空态文案；搜索过滤仅作用于启用集
 * 宿主包一层 DropdownMenu（Sub 不能脱离 Menu 上下文渲染），二级经
 * pointerEnter 打开（Radix Menu 子菜单触发语义，同 expert-sub-menu 测试）
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/i18n", () => ({
  default: { t: (key: string) => key },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: { info: vi.fn(), error: vi.fn(), warning: vi.fn(), success: vi.fn() },
}));
const { invokeMock, skillsData } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  skillsData: {
    value: [
      { id: 1, name: "alpha-skill", enabled: true, description: "启用的技能" },
      { id: 2, name: "beta-skill", enabled: false, description: "禁用的技能" },
      { id: 3, name: "gamma-skill", enabled: true, description: null },
    ],
  },
}));
vi.mock("@/lib/ipc", () => ({ invoke: invokeMock }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: skillsData.value }),
}));

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "../../src-react/components/ui/dropdown-menu";
import SkillSubMenu from "../../src-react/domains/ai/chat/components/skill-sub-menu";

/** 打开根菜单并 hover 技能子触发器，等二级首项出现 */
async function openSkillPanel(): Promise<void> {
  const trigger = screen.getByRole("button", { name: "root" });
  fireEvent.pointerDown(trigger, { button: 0 });
  fireEvent.click(trigger);
  await waitFor(() => {
    expect(screen.getByText("chat:plus.skill")).toBeTruthy();
  });
  fireEvent.pointerEnter(screen.getByText("chat:plus.skill"));
  // Radix MenuSubTrigger 仅在 pointerType==='mouse' 的 pointerMove 时打开子菜单
  fireEvent.pointerMove(screen.getByText("chat:plus.skill"), {
    pointerType: "mouse",
  });
  await waitFor(() => {
    // 搜索框随 SubContent 渲染，作打开锚点（列表内容随用例数据各异）
    expect(
      screen.getByPlaceholderText("chat:plus.searchSkills"),
    ).toBeTruthy();
  });
}

afterEach(cleanup);

function renderHost(
  props: Partial<Parameters<typeof SkillSubMenu>[0]> = {},
): void {
  render(
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button>root</button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <SkillSubMenu
          onImport={() => undefined}
          referencedSkills={[]}
          onToggleSkill={() => undefined}
          {...props}
        />
      </DropdownMenuContent>
    </DropdownMenu>,
  );
}

describe("SkillSubMenu（引用选择器语义）", () => {
  it("仅渲染已启用技能：禁用技能隐藏", async () => {
    renderHost();
    await openSkillPanel();
    expect(screen.getByText("alpha-skill")).toBeTruthy();
    expect(screen.getByText("gamma-skill")).toBeTruthy();
    expect(screen.queryByText("beta-skill")).toBeNull();
  });

  it("点击技能调 onToggleSkill 回传名称，不调 skill:setEnabled IPC", async () => {
    invokeMock.mockReset();
    const onToggleSkill = vi.fn();
    renderHost({ onToggleSkill });
    await openSkillPanel();
    fireEvent.click(screen.getByText("alpha-skill"));
    await waitFor(() =>
      expect(onToggleSkill).toHaveBeenCalledWith("alpha-skill"),
    );
    expect(invokeMock).not.toHaveBeenCalledWith(
      "skill:setEnabled",
      expect.anything(),
      expect.anything(),
    );
  });

  it("referencedSkills 匹配项勾选 Check，未引用项不勾", async () => {
    renderHost({ referencedSkills: ["gamma-skill"] });
    await openSkillPanel();
    const checked = screen.getByRole("menuitem", { name: /gamma-skill/ });
    expect(checked.querySelector("svg.lucide-check")).not.toBeNull();
    const unchecked = screen.getByRole("menuitem", { name: /alpha-skill/ });
    expect(unchecked.querySelector("svg.lucide-check")).toBeNull();
  });

  it("无启用技能时渲染空态文案", async () => {
    const saved = skillsData.value;
    skillsData.value = [{ id: 1, name: "beta-skill", enabled: false }];
    renderHost();
    await openSkillPanel();
    expect(screen.getByText("chat:plus.skillNoneEnabled")).toBeTruthy();
    skillsData.value = saved;
  });

  it("搜索过滤仅作用于启用集（名称/描述匹配）", async () => {
    renderHost();
    await openSkillPanel();
    const input = screen.getByPlaceholderText("chat:plus.searchSkills");
    fireEvent.change(input, { target: { value: "beta" } });
    // beta-skill 已禁用：即使搜其名也不出现（无结果态）
    await waitFor(() => {
      expect(screen.getByText("chat:plus.skillNoMatch")).toBeTruthy();
    });
    fireEvent.change(input, { target: { value: "启用的" } });
    await waitFor(() => {
      expect(screen.getByText("alpha-skill")).toBeTruthy();
    });
  });
});

// @vitest-environment jsdom
/**
 * ExpertSubMenu 组件测试：+ 菜单「专家」二级浮层的两种工作模式——
 * - 会话模式（sessionId）：选中调 SessionApi.setAssistant 写会话（现有行为回归）
 * - 草稿模式（onPick，落地页 PlusMenu 对齐）：选中纯前端回调暂存，不碰 IPC；
 *   "默认助手"项回传 null；currentAssistantId 匹配项勾选 Check
 * - 团队标识：expertType=team 条目名称后渲染「专家团」小徽章
 *   （Users 图标 + typeTeam 文案 + 成员数），单专家行不渲染
 * 宿主包一层 DropdownMenu（Sub 不能脱离 Menu 上下文渲染），二级经
 * pointerEnter 打开（Radix Menu 子菜单触发语义）
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

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
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ invoke: invokeMock }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: [
      { id: 1, name: "Al", icon: null },
      { id: 2, name: "Be", icon: null },
      {
        id: 3,
        name: "团",
        icon: null,
        expertType: "team",
        members: [
          { id: "m1", name: "策划", profession: "选题", systemPrompt: "s" },
          { id: "m2", name: "写手", profession: "成稿", systemPrompt: "s" },
          { id: "m3", name: "审校", profession: "把关", systemPrompt: "s" },
        ],
      },
    ],
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "../../src-react/components/ui/dropdown-menu";
import { toast } from "sonner";
import ExpertSubMenu from "../../src-react/domains/ai/chat/components/expert-sub-menu";

/** 打开根菜单并 hover 专家子触发器，等二级首项出现 */
async function openExpertPanel(): Promise<void> {
  const trigger = screen.getByRole("button", { name: "root" });
  fireEvent.pointerDown(trigger, { button: 0 });
  fireEvent.click(trigger);
  await waitFor(() => {
    expect(screen.getByText("chat:plus.expert")).toBeTruthy();
  });
  fireEvent.pointerEnter(screen.getByText("chat:plus.expert"));
  // Radix MenuSubTrigger 仅在 pointerType==='mouse' 的 pointerMove 时打开子菜单
  fireEvent.pointerMove(screen.getByText("chat:plus.expert"), {
    pointerType: "mouse",
  });
  await waitFor(() => {
    expect(screen.getByText("Be")).toBeTruthy();
  });
}

afterEach(cleanup);

function renderHost(props: Parameters<typeof ExpertSubMenu>[0]): void {
  render(
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button>root</button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <ExpertSubMenu {...props} />
      </DropdownMenuContent>
    </DropdownMenu>,
  );
}

describe("ExpertSubMenu", () => {
  it("会话模式回归：选中调 session:setAssistant 写会话", async () => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    renderHost({ sessionId: 1, currentAssistantId: undefined });
    await openExpertPanel();
    fireEvent.click(screen.getByText("Be"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("session:setAssistant", 1, 2),
    );
  });

  it("哨兵会话（id<0，文件窗占位）：选中轻提示不发 IPC（修复轮 1 Minor ③）", async () => {
    invokeMock.mockReset();
    vi.mocked(toast.info).mockClear();
    renderHost({ sessionId: -1, currentAssistantId: undefined });
    await openExpertPanel();
    fireEvent.click(screen.getByText("Be"));
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(
        "chat:input.lockedUntilFirstSend",
      ),
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("草稿模式（onPick）：选中纯回调暂存，不调 session:setAssistant", async () => {
    invokeMock.mockReset();
    const onPick = vi.fn();
    renderHost({ onPick, currentAssistantId: undefined });
    await openExpertPanel();
    fireEvent.click(screen.getByText("Be"));
    await waitFor(() => expect(onPick).toHaveBeenCalledWith(2));
    expect(invokeMock).not.toHaveBeenCalledWith(
      "session:setAssistant",
      expect.anything(),
      expect.anything(),
    );
  });

  it("草稿模式点「默认助手」回传 null", async () => {
    const onPick = vi.fn();
    renderHost({ onPick, currentAssistantId: 5 });
    await openExpertPanel();
    fireEvent.click(screen.getByText("chat:plus.noAssistant"));
    await waitFor(() => expect(onPick).toHaveBeenCalledWith(null));
  });

  it("草稿模式 currentAssistantId 匹配项勾选 Check", async () => {
    renderHost({ onPick: () => undefined, currentAssistantId: 2 });
    await openExpertPanel();
    const item = screen.getByRole("menuitem", { name: /Be/ });
    expect(item.querySelector("svg.lucide-check")).not.toBeNull();
  });

  it("团队条目渲染「专家团」徽章（Users 图标+文案+成员数），单专家行不渲染", async () => {
    renderHost({ onPick: () => undefined, currentAssistantId: undefined });
    await openExpertPanel();
    // 团队行徽章：typeTeam key 文案（i18n mock 直返 key）+ 成员数 3
    const badge = screen.getByText(/chat:experts\.market\.typeTeam/);
    expect(badge.textContent).toBe("chat:experts.market.typeTeam 3");
    const teamItem = screen.getByRole("menuitem", { name: /团/ });
    expect(teamItem.querySelector("svg.lucide-users")).not.toBeNull();
    // 单专家行：无 Users 图标徽章（列表底部「召唤更多专家」不在 Al 行内）
    const singleItem = screen.getByRole("menuitem", { name: /Al/ });
    expect(singleItem.querySelector("svg.lucide-users")).toBeNull();
  });
});

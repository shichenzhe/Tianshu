// @vitest-environment jsdom
/**
 * ＋菜单能力过滤测试（Task 9：项目动态流仅展示已挂载能力）：
 * - 传 allowedIds/allowedNames → 专家/技能子菜单仅显示白名单项
 * - 未传 → 不过滤、全量显示（AI 模块 ChatView 不传，行为不变的回归锚点）
 * 数据源 mock：AssistantApi.list / SkillApi.list 返回固定列表（两子菜单
 * useQuery 的 queryFn 即此二者），mock 骨架照 tests/ai/plus-menu.test.tsx
 * （i18n 直返 key）。注：PlusMenu 的 ＋ 触发按钮在当前分支存在 asChild
 * 嵌套回归（b68d536，主仓修复未合入），无法经完整菜单链交互，故以
 * DropdownMenu 包裹直接渲染真实子菜单验证过滤（与生产同组件路径）
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "../../src-react/components/ui/dropdown-menu";

// fixture 经 vi.hoisted 提升供 hoisted 的 mock 工厂引用
const { ASSISTANTS, SKILLS } = vi.hoisted(() => ({
  ASSISTANTS: [
    {
      id: 1,
      name: "专家A",
      systemPrompt: "",
      builtin: true,
      createdAt: "2026-09-12T00:00:00.000Z",
      updatedAt: "2026-09-12T00:00:00.000Z",
    },
    {
      id: 2,
      name: "专家B",
      systemPrompt: "",
      builtin: true,
      createdAt: "2026-09-12T00:00:00.000Z",
      updatedAt: "2026-09-12T00:00:00.000Z",
    },
    {
      id: 3,
      name: "专家C",
      systemPrompt: "",
      builtin: true,
      createdAt: "2026-09-12T00:00:00.000Z",
      updatedAt: "2026-09-12T00:00:00.000Z",
    },
  ],
  SKILLS: [
    {
      id: 1,
      name: "alpha-skill",
      slug: null,
      version: null,
      source: "builtin",
      dir: "",
      description: null,
      enabled: true,
      installedAt: "2026-09-12T00:00:00.000Z",
    },
    {
      id: 2,
      name: "beta-skill",
      slug: null,
      version: null,
      source: "builtin",
      dir: "",
      description: null,
      enabled: false,
      installedAt: "2026-09-12T00:00:00.000Z",
    },
  ],
}));

// i18n mock：t 直接返回 key（菜单项名即 key），断言不依赖具体文案
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

// 数据源 mock：子菜单 useQuery 的 queryFn
vi.mock("../../src-react/domains/ai/api/assistant.api", () => ({
  default: { list: () => Promise.resolve(ASSISTANTS) },
}));
vi.mock("../../src-react/domains/ai/skills/api/skill.api", () => ({
  default: { list: () => Promise.resolve(SKILLS) },
}));

import ExpertSubMenu from "../../src-react/domains/ai/chat/components/expert-sub-menu";
import SkillSubMenu from "../../src-react/domains/ai/chat/components/skill-sub-menu";

/** 真实子菜单挂进可用菜单（pointerDown 开根 → 点二级触发器开浮层） */
function renderInMenu(subMenu: ReactElement): void {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>
        <DropdownMenu>
          <DropdownMenuTrigger>toggle</DropdownMenuTrigger>
          <DropdownMenuContent>{subMenu}</DropdownMenuContent>
        </DropdownMenu>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 开根菜单（pointerDown+click，同 tests/ai/plus-menu.test.tsx）后点二级触发器 */
async function openSubMenu(subTriggerLabel: string): Promise<void> {
  const trigger = screen.getByText("toggle");
  fireEvent.pointerDown(trigger, { button: 0 });
  fireEvent.click(trigger);
  await waitFor(() => expect(screen.getByText(subTriggerLabel)).toBeTruthy());
  fireEvent.click(screen.getByText(subTriggerLabel));
}

afterEach(cleanup);

describe("＋菜单能力过滤", () => {
  it("传入 allowedIds → 专家子菜单仅显示已挂载专家", async () => {
    renderInMenu(<ExpertSubMenu sessionId={1} allowedIds={[1]} />);
    await openSubMenu("chat:plus.expert");
    expect(await screen.findByText("专家A")).toBeTruthy();
    expect(screen.queryByText("专家B")).toBeNull();
    expect(screen.queryByText("专家C")).toBeNull();
  });

  it("未传 allowedIds → 不过滤，全量显示", async () => {
    renderInMenu(<ExpertSubMenu sessionId={1} />);
    await openSubMenu("chat:plus.expert");
    expect(await screen.findByText("专家A")).toBeTruthy();
    expect(screen.getByText("专家B")).toBeTruthy();
    expect(screen.getByText("专家C")).toBeTruthy();
  });

  it("传入 allowedNames → 技能子菜单仅显示已挂载技能", async () => {
    renderInMenu(
      <SkillSubMenu
        onImport={() => undefined}
        allowedNames={["alpha-skill"]}
      />,
    );
    await openSubMenu("chat:plus.skill");
    expect(await screen.findByText("alpha-skill")).toBeTruthy();
    expect(screen.queryByText("beta-skill")).toBeNull();
  });

  it("未传 allowedNames → 不过滤，全量显示", async () => {
    renderInMenu(<SkillSubMenu onImport={() => undefined} />);
    await openSubMenu("chat:plus.skill");
    expect(await screen.findByText("alpha-skill")).toBeTruthy();
    expect(screen.getByText("beta-skill")).toBeTruthy();
  });
});

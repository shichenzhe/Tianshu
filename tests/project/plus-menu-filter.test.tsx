// @vitest-environment jsdom
/**
 * ＋菜单能力过滤测试（Task 9：项目动态流仅展示已挂载能力）：
 * - 传 boundAssistantIds/boundSkillNames → 专家/技能子菜单仅显示白名单项
 * - 未传 → 不过滤、全量显示（AI 模块 ChatView 不传，行为不变的回归锚点）
 * 全链路交互：渲染真实 PlusMenu，经 ＋ 触发按钮（pointerDown+click 开根，
 * 点二级触发器开浮层）驱动。触发嵌套已修复：TooltipProvider 最外层、
 * 两个 asChild 触发器直连 Button 合并事件 props（b68d536 回归，正确
 * 嵌套参照 context-usage-button.tsx，与主仓 tests/ai/plus-menu.test.tsx
 * 同驱动方式）。数据源 mock：AssistantApi.list / SkillApi.list 返回固定
 * 列表（两子菜单 useQuery 的 queryFn 即此二者），i18n 直返 key。
 * SkillImportDialog 与过滤无关且依赖较重，mock 为空组件。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

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

// 导入弹窗依赖较重且与过滤断言无关
vi.mock(
  "../../src-react/domains/ai/skills/components/SkillImportDialog",
  () => ({
    default: () => null,
  }),
);

import PlusMenu from "../../src-react/domains/ai/chat/components/PlusMenu";

/** 渲染真实 PlusMenu（过滤 props 透传，其余给与 ChatView 一致的默认值） */
function renderPlusMenu(props: Partial<ComponentProps<typeof PlusMenu>>): void {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>
        <PlusMenu
          sessionId={1}
          currentMode="agent"
          onPickPaths={() => undefined}
          onOpenMcp={() => undefined}
          {...props}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 开根菜单：Radix DropdownMenuTrigger 经 pointerDown(主键)+click 打开 */
async function openPlusMenu(): Promise<void> {
  const trigger = screen.getByRole("button", {
    name: "chat:input.addMenuHint",
  });
  fireEvent.pointerDown(trigger, { button: 0 });
  fireEvent.click(trigger);
  await waitFor(() =>
    expect(screen.getByText("chat:plus.addFile")).toBeTruthy(),
  );
}

/** 根菜单展开后点二级触发器开浮层 */
async function openSubMenu(subTriggerLabel: string): Promise<void> {
  await openPlusMenu();
  await waitFor(() => expect(screen.getByText(subTriggerLabel)).toBeTruthy());
  fireEvent.click(screen.getByText(subTriggerLabel));
}

afterEach(cleanup);

describe("＋菜单能力过滤", () => {
  it("点击 ＋ 触发按钮应打开扩展菜单（嵌套修复回归锚点）", async () => {
    renderPlusMenu({});
    await openPlusMenu();
    expect(screen.getByText("chat:plus.connector")).toBeTruthy();
  });

  it("传入 boundAssistantIds → 专家子菜单仅显示已挂载专家", async () => {
    renderPlusMenu({ boundAssistantIds: [1] });
    await openSubMenu("chat:plus.expert");
    expect(await screen.findByText("专家A")).toBeTruthy();
    expect(screen.queryByText("专家B")).toBeNull();
    expect(screen.queryByText("专家C")).toBeNull();
  });

  it("未传 boundAssistantIds → 不过滤，全量显示", async () => {
    renderPlusMenu({});
    await openSubMenu("chat:plus.expert");
    expect(await screen.findByText("专家A")).toBeTruthy();
    expect(screen.getByText("专家B")).toBeTruthy();
    expect(screen.getByText("专家C")).toBeTruthy();
  });

  it("传入 boundSkillNames → 技能子菜单仅显示已挂载技能", async () => {
    renderPlusMenu({ boundSkillNames: ["alpha-skill"] });
    await openSubMenu("chat:plus.skill");
    expect(await screen.findByText("alpha-skill")).toBeTruthy();
    expect(screen.queryByText("beta-skill")).toBeNull();
  });

  it("未传 boundSkillNames → 不过滤，全量显示", async () => {
    renderPlusMenu({});
    await openSubMenu("chat:plus.skill");
    expect(await screen.findByText("alpha-skill")).toBeTruthy();
    expect(screen.getByText("beta-skill")).toBeTruthy();
  });
});

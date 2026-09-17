// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// cn 依赖 @/i18n 实例，最小桩避免拉起完整 i18n 栈
vi.mock("@/i18n", () => ({
  default: { t: (key: string) => key },
}));

import NewTaskView from "@/domains/ai/new-task/views/NewTaskView";

describe("NewTaskView 骨架", () => {
  it("渲染标题与场景 Tab", () => {
    render(
      <MemoryRouter>
        <NewTaskView />
      </MemoryRouter>,
    );
    // 注：仓库未装 @testing-library/jest-dom（全仓 0 处 toBeInTheDocument），
    // 沿用既有断言口径 toBeTruthy（同 tests/ai/chat-input-todo.test.tsx）
    expect(screen.getByText("newTask:heroTitle")).toBeTruthy();
    expect(screen.getByText("newTask:scenario.daily")).toBeTruthy();
  });
});

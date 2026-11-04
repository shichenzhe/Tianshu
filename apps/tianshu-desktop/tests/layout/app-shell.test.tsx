// @vitest-environment jsdom
/** AppShell：Windows 独立标题栏与父容器高度，其他平台无额外壳 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("../../src-react/components/layout/windows-titlebar", () => ({
  default: () => <div data-testid="windows-titlebar" />,
}));

import AppShell from "../../src-react/components/layout/app-shell";

beforeEach(() => {
  Object.defineProperty(window, "platform", {
    value: "win32",
    configurable: true,
    writable: true,
  });
});
afterEach(cleanup);

describe("AppShell", () => {
  it("Windows 标题栏唯一且位于内容前，内容占满剩余高度", () => {
    const { container } = render(
      <AppShell>
        <main data-testid="route-content" />
      </AppShell>,
    );
    expect(screen.getAllByTestId("windows-titlebar")).toHaveLength(1);
    const shell = container.querySelector("[data-app-shell]")!;
    expect(shell.classList).toContain("h-screen");
    expect(shell.classList).toContain("flex-col");
    expect(shell.firstElementChild).toBe(
      screen.getByTestId("windows-titlebar"),
    );
    const content = screen.getByTestId("route-content").parentElement!;
    expect(content.classList).toContain("min-h-0");
    expect(content.classList).toContain("flex-1");
  });

  it("非 Windows 不渲染标题栏或额外壳", () => {
    window.platform = "darwin";
    const { container } = render(
      <AppShell>
        <main data-testid="route-content" />
      </AppShell>,
    );
    expect(screen.queryByTestId("windows-titlebar")).toBeNull();
    expect(container.querySelector("[data-app-shell]")).toBeNull();
    expect(container.firstElementChild).toBe(
      screen.getByTestId("route-content"),
    );
  });
});

// tests/ai/permission-mode.test.ts
// @vitest-environment jsdom
/**
 * 权限二档单测：PermissionStore（default 缺省/覆盖/会话隔离）+
 * PermissionCapsule 二档单选面板（两档渲染+desc key、选中态、default 直切、
 * full 经 FullAccessModal 强确认——取消保持原档）。i18n t mock 直返 key
 * （角色名/文案即 key）；Radix Popover 点击触发开、AlertDialog 经点击
 * 取消/勾选免责确认（同 workspace-picker-menu.test.tsx）。
 */
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { PermissionStore } from "../../electron/domains/ai/agent/permission-mode";

// vitest.config 未开 globals,RTL 自动清理不生效,手动注册（同
// tests/ai/new-task-toolbars.test.tsx）
afterEach(cleanup);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
// cn 依赖 @/i18n 实例（Popover/AlertDialog→cn），最小桩避免拉起完整 i18n 栈
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));

import PermissionCapsule from "@/domains/ai/chat/components/PermissionCapsule";

describe("PermissionStore", () => {
  it("未设置的会话缺省返回 default", () => {
    const store = new PermissionStore();
    expect(store.get(1)).toBe("default");
  });

  it("set 后 get 返回新值（覆盖）", () => {
    const store = new PermissionStore();
    store.set(1, "full");
    expect(store.get(1)).toBe("full");
    store.set(1, "default");
    expect(store.get(1)).toBe("default");
  });

  it("会话间互不影响（隔离）", () => {
    const store = new PermissionStore();
    store.set(1, "full");
    expect(store.get(1)).toBe("full");
    expect(store.get(2)).toBe("default");
  });
});

/** 触发胶囊（aria-label = 面板标题 key）；受控渲染并返回 onChange 桩
 * （文件为 .ts，经 createElement 渲染无 JSX） */
function renderCapsule(accessMode: "default" | "full") {
  const onChange = vi.fn();
  render(createElement(PermissionCapsule, { accessMode, onChange }));
  return onChange;
}

/** 点击胶囊打开面板并等首行描述出现 */
async function openPanel(): Promise<void> {
  fireEvent.click(
    screen.getByRole("button", { name: "chat:permission.modeSelector" }),
  );
  await waitFor(() =>
    expect(screen.getByText("chat:permission.descDefault")).toBeTruthy(),
  );
}

/** 面板内档位行按钮（可访问名 = 标题 key + 描述 key） */
function modeRow(value: "default" | "full"): HTMLElement {
  return screen.getByRole("button", {
    name: new RegExp(`chat:permission\\.${value}`),
  });
}

describe("PermissionCapsule 二档单选面板", () => {
  it("两档单选齐备：面板标题+两档标题/描述 key；选中档带选中态", async () => {
    renderCapsule("default");
    await openPanel();
    expect(screen.getByText("chat:permission.modeSelector")).toBeTruthy();
    expect(screen.getByText("chat:permission.descDefault")).toBeTruthy();
    expect(screen.getByText("chat:permission.descFull")).toBeTruthy();
    // 两档行齐备（可访问名 = 标题 key + 描述 key）；选中态：default 行
    // 按下、full 行未按下（Check 只挂选中行；触发胶囊文案与行标题同 key）
    expect(modeRow("default").getAttribute("aria-pressed")).toBe("true");
    expect(modeRow("full").getAttribute("aria-pressed")).toBe("false");
  });

  it("选 default 直接回落 onChange（无确认弹窗）", async () => {
    const onChange = renderCapsule("full");
    await openPanel();
    fireEvent.click(modeRow("default"));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("default");
    expect(screen.queryByText("chat:permission.modalRisk")).toBeNull();
  });

  it("选 full 先弹 FullAccessModal；取消保持原档不切", async () => {
    const onChange = renderCapsule("default");
    await openPanel();
    fireEvent.click(modeRow("full"));
    await waitFor(() =>
      expect(screen.getByText("chat:permission.modalRisk")).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "common:cancel" }));
    await waitFor(() =>
      expect(screen.queryByText("chat:permission.modalRisk")).toBeNull(),
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("选 full 勾选免责确认后 onChange('full')；未勾选确认钮禁用", async () => {
    const onChange = renderCapsule("default");
    await openPanel();
    fireEvent.click(modeRow("full"));
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "chat:permission.confirmFullAccess",
        }),
      ).toBeTruthy(),
    );
    // 未勾选免责前确认钮禁用（强制确认语义）
    expect(
      (
        screen.getByRole("button", {
          name: "chat:permission.confirmFullAccess",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(
      screen.getByRole("button", { name: "chat:permission.confirmFullAccess" }),
    );
    expect(onChange).toHaveBeenCalledExactlyOnceWith("full");
  });
});

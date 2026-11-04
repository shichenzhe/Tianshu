// @vitest-environment jsdom
/**
 * FileTabHeader 工具行：标题=resource.path、saveStatus 徽标四态（hidden
 * 不渲染）、保存按钮仅 dirty 可见且点击回调、另存为（成功 toast/取消
 * 静默/失败 toast）/Finder/AI 对话动作、冲突确认条 overwrite/reload 回调；
 * 非 workspace tab 不渲染。mock 骨架同 file-tab-content.test.tsx。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { toast } from "sonner";

vi.mock("react-i18next", async (importOriginal) => {
  // 部分 mock：initReactI18next 保留给 @/i18n（mapIpcError 间接依赖）
  const actual = await importOriginal<typeof import("react-i18next")>();
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const readFileMock = vi.hoisted(() => vi.fn());
const revealFileMock = vi.hoisted(() => vi.fn());
const exportFileMock = vi.hoisted(() => vi.fn());
vi.mock("../../../src-react/domains/ai/api/artifact.api", () => ({
  default: {
    readFile: readFileMock,
    revealFile: revealFileMock,
    exportFile: exportFileMock,
  },
}));

import { useFileWindowStore } from "../../../src-react/domains/ai/file-window/store/file-window.store";
import FileTabHeader from "../../../src-react/domains/ai/file-window/components/FileTabHeader";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useFileWindowStore.getState().reset();
});

function openWsTab(path = "a.md") {
  return useFileWindowStore
    .getState()
    .openTab({ kind: "workspace", workspaceId: 7, path }).tabId;
}

function renderHeader(tabId: string, conflict = false) {
  const onSave = vi.fn();
  const onResolveConflict = vi.fn();
  const { container } = render(
    <FileTabHeader
      tabId={tabId}
      onSave={onSave}
      conflict={conflict}
      onResolveConflict={onResolveConflict}
    />,
  );
  return { onSave, onResolveConflict, container };
}

describe("FileTabHeader 工具行", () => {
  it("标题=resource.path；徽标按 saveStatus 渲染（saved）", () => {
    const tabId = openWsTab("docs/a.md");
    renderHeader(tabId);
    expect(screen.getByText("docs/a.md")).toBeTruthy();
    expect(screen.getByText("chat:fileWindow.saveStatus.saved")).toBeTruthy();
  });

  it("徽标 unsaved/saving 文案随 patchTab 切换", () => {
    const tabId = openWsTab();
    renderHeader(tabId);
    act(() => {
      useFileWindowStore.getState().patchTab(tabId, { saveStatus: "unsaved" });
    });
    expect(screen.getByText("chat:fileWindow.saveStatus.unsaved")).toBeTruthy();
    act(() => {
      useFileWindowStore.getState().patchTab(tabId, { saveStatus: "saving" });
    });
    expect(screen.getByText("chat:fileWindow.saveStatus.saving")).toBeTruthy();
    expect(screen.queryByText("chat:fileWindow.saveStatus.saved")).toBeNull();
  });

  it("只读类（hidden）不渲染徽标", () => {
    openWsTab("a.png"); // contentKind=image → saveStatus=hidden
    const tabId = useFileWindowStore.getState().activeTabId;
    renderHeader(tabId);
    expect(document.querySelector("span.text-xs")).toBeNull();
  });

  it("保存按钮仅 dirty 可见；点击回调 onSave", () => {
    const tabId = openWsTab();
    const { onSave } = renderHeader(tabId);
    expect(
      screen.queryByRole("button", { name: "chat:fileWindow.action.save" }),
    ).toBeNull();
    act(() => {
      useFileWindowStore.getState().patchTab(tabId, { dirty: true });
    });
    fireEvent.click(
      screen.getByRole("button", { name: "chat:fileWindow.action.save" }),
    );
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("另存为：exportFile 成功 toast；取消（null）静默不 toast", async () => {
    exportFileMock.mockResolvedValueOnce("/Users/x/copy.md");
    const tabId = openWsTab();
    renderHeader(tabId);
    fireEvent.click(
      screen.getByRole("button", { name: "chat:fileWindow.action.saveAs" }),
    );
    expect(exportFileMock).toHaveBeenCalledWith(7, "a.md");
    await vi.waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "chat:artifacts.exportSuccess",
      ),
    );
    exportFileMock.mockResolvedValueOnce(null);
    fireEvent.click(
      screen.getByRole("button", { name: "chat:fileWindow.action.saveAs" }),
    );
    await vi.waitFor(() => expect(exportFileMock).toHaveBeenCalledTimes(2));
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it("另存为失败 → toast.error（mapIpcError 透传原文）", async () => {
    exportFileMock.mockRejectedValue(new Error("导出失败"));
    renderHeader(openWsTab());
    fireEvent.click(
      screen.getByRole("button", { name: "chat:fileWindow.action.saveAs" }),
    );
    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("导出失败"),
    );
  });

  it("Finder → revealFile(workspaceId, path)；失败 toast", async () => {
    revealFileMock.mockRejectedValue(new Error("打不开"));
    renderHeader(openWsTab());
    fireEvent.click(
      screen.getByRole("button", { name: "chat:fileWindow.action.reveal" }),
    );
    await vi.waitFor(() =>
      expect(revealFileMock).toHaveBeenCalledWith(7, "a.md"),
    );
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith("打不开"));
  });

  it("AI 对话开关 → patchTab aiPanelOpen 翻转", () => {
    const tabId = openWsTab();
    renderHeader(tabId);
    expect(
      useFileWindowStore.getState().tabs.find((t) => t.id === tabId)
        ?.aiPanelOpen,
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: "chat:fileWindow.action.aiChat" }),
    );
    expect(
      useFileWindowStore.getState().tabs.find((t) => t.id === tabId)
        ?.aiPanelOpen,
    ).toBe(false);
  });

  it("冲突条：overwrite/reload 按钮回调 onResolveConflict(mode)", () => {
    const { onResolveConflict } = renderHeader(openWsTab(), true);
    expect(screen.getByText("chat:fileWindow.conflict.title")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: "chat:fileWindow.conflict.overwrite",
      }),
    );
    expect(onResolveConflict).toHaveBeenCalledWith("overwrite");
    fireEvent.click(
      screen.getByRole("button", { name: "chat:fileWindow.conflict.reload" }),
    );
    expect(onResolveConflict).toHaveBeenCalledWith("reload");
  });

  it("conflict=false 不渲染确认条", () => {
    renderHeader(openWsTab(), false);
    expect(screen.queryByText("chat:fileWindow.conflict.title")).toBeNull();
  });

  it("externalChanged → 条幅复用（external 变体按钮）：keepMine/reload 回调", () => {
    const tabId = openWsTab();
    useFileWindowStore.getState().patchTab(tabId, { externalChanged: true });
    const { onResolveConflict } = renderHeader(tabId, false);
    expect(screen.getByText("chat:fileWindow.conflict.title")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: "chat:fileWindow.conflict.keepMine",
      }),
    );
    expect(onResolveConflict).toHaveBeenCalledWith("keepMine");
    fireEvent.click(
      screen.getByRole("button", {
        name: "chat:fileWindow.conflict.reloadDisk",
      }),
    );
    expect(onResolveConflict).toHaveBeenCalledWith("reload");
  });

  it("conflict 与 externalChanged 并存 → 保存冲突按钮优先（overwrite/reload）", () => {
    const tabId = openWsTab();
    useFileWindowStore.getState().patchTab(tabId, { externalChanged: true });
    renderHeader(tabId, true);
    expect(
      screen.getByRole("button", {
        name: "chat:fileWindow.conflict.overwrite",
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "chat:fileWindow.conflict.keepMine",
      }),
    ).toBeNull();
  });

  it("externalChanged 撤下（patchTab false）→ 条幅消失", () => {
    const tabId = openWsTab();
    useFileWindowStore.getState().patchTab(tabId, { externalChanged: true });
    renderHeader(tabId, false);
    expect(screen.getByText("chat:fileWindow.conflict.title")).toBeTruthy();
    act(() => {
      useFileWindowStore.getState().patchTab(tabId, { externalChanged: false });
    });
    expect(screen.queryByText("chat:fileWindow.conflict.title")).toBeNull();
  });
});

// @vitest-environment jsdom
/**
 * 保存流（spec §5.2）：dirty → saving → 写成功 saved + baselineMtime 更新；
 * FILE_CONFLICT → conflict 态（saveStatus 回 unsaved，不卡 saving）；
 * overwrite 以 baselineMtime=null 免基线重写；reload 重读清 dirty/unsaved
 * 并 invalidate fw-file；非冲突错误回 unsaved + toast。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("../../../src-react/lib/ipc", () => ({ invoke: invokeMock }));
const readFileMock = vi.hoisted(() => vi.fn());
vi.mock("../../../src-react/domains/ai/api/artifact.api", () => ({
  default: {
    readFile: readFileMock,
    revealFile: vi.fn(),
    exportFile: vi.fn(),
  },
}));
vi.mock("react-i18next", async (importOriginal) => {
  // 部分 mock：initReactI18next 保留给 @/i18n（mapIpcError 间接依赖）
  const actual = await importOriginal<typeof import("react-i18next")>();
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { useFileWindowStore } from "../../../src-react/domains/ai/file-window/store/file-window.store";
import { useSaveTab } from "../../../src-react/domains/ai/file-window/hooks/use-save-tab";

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
  readFileMock.mockReset();
  vi.clearAllMocks();
  useFileWindowStore.getState().reset();
});

/** 挂 hook（独立 QueryClient，spy invalidateQueries 供重载断言） */
function renderSave(tabId: string) {
  const client = new QueryClient();
  const invalidateSpy = vi.spyOn(client, "invalidateQueries");
  const utils = renderHook(() => useSaveTab(tabId), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  return { ...utils, invalidateSpy };
}

function openDirtyTab(baselineMtime: number | null) {
  const { tabId } = useFileWindowStore
    .getState()
    .openTab({ kind: "workspace", workspaceId: 7, path: "a.md" });
  useFileWindowStore
    .getState()
    .patchTab(tabId, { dirty: true, saveStatus: "unsaved", baselineMtime });
  return tabId;
}

describe("useSaveTab", () => {
  it("保存成功链路：saving → saved、清 dirty、基线更新、invalidate fw-file", async () => {
    const tabId = openDirtyTab(null);
    invokeMock.mockResolvedValue({ absPath: "/x/a.md", mtime: 12345 });
    const { result, invalidateSpy } = renderSave(tabId);
    act(() => {
      void result.current.save("新内容");
    });
    await waitFor(() => {
      const tab = useFileWindowStore.getState().tabs[0];
      expect(tab.saveStatus).toBe("saved");
      expect(tab.dirty).toBe(false);
      expect(tab.baselineMtime).toBe(12345);
    });
    expect(invokeMock).toHaveBeenCalledWith("workspace:writeFile", {
      workspaceId: 7,
      path: "a.md",
      content: "新内容",
      baselineMtime: null,
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["fw-file"] });
  });

  it("冲突 → conflict 态（saveStatus 回 unsaved）；overwrite 免基线重写", async () => {
    const tabId = openDirtyTab(1);
    invokeMock
      .mockRejectedValueOnce(new Error("FILE_CONFLICT"))
      .mockResolvedValue({ absPath: "/x/a.md", mtime: 2 });
    const { result } = renderSave(tabId);
    act(() => {
      void result.current.save("我的");
    });
    await waitFor(() => expect(result.current.conflict).toBe(true));
    // 冲突横条期间不卡「保存中」徽标：内容仍未保存
    expect(useFileWindowStore.getState().tabs[0].saveStatus).toBe("unsaved");
    act(() => {
      void result.current.resolveConflict("overwrite", "我的");
    });
    await waitFor(() => {
      expect(useFileWindowStore.getState().tabs[0].saveStatus).toBe("saved");
    });
    const tab = useFileWindowStore.getState().tabs[0];
    expect(tab.dirty).toBe(false);
    expect(tab.baselineMtime).toBe(2);
    expect(result.current.conflict).toBe(false);
    // 免基线重写：第二次调用 baselineMtime=null
    expect(invokeMock).toHaveBeenLastCalledWith("workspace:writeFile", {
      workspaceId: 7,
      path: "a.md",
      content: "我的",
      baselineMtime: null,
    });
  });

  it("冲突 → reload：放弃本地修改，清 dirty/saved + invalidate fw-file（不再写盘）", async () => {
    const tabId = openDirtyTab(1);
    invokeMock.mockRejectedValueOnce(new Error("FILE_CONFLICT"));
    const { result, invalidateSpy } = renderSave(tabId);
    act(() => {
      void result.current.save("我的");
    });
    await waitFor(() => expect(result.current.conflict).toBe(true));
    act(() => {
      void result.current.resolveConflict("reload", "我的");
    });
    await waitFor(() => {
      expect(useFileWindowStore.getState().tabs[0].dirty).toBe(false);
    });
    const tab = useFileWindowStore.getState().tabs[0];
    expect(tab.saveStatus).toBe("saved");
    expect(result.current.conflict).toBe(false);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["fw-file"] });
    // reload 不触发第二次写盘
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("保存中再 save 不重复写盘（in-flight 门：连点/再 ⌘S）", async () => {
    const tabId = openDirtyTab(null);
    let resolveWrite: (v: { absPath: string; mtime: number }) => void;
    invokeMock.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveWrite = res;
        }),
    );
    const { result } = renderSave(tabId);
    act(() => {
      void result.current.save("a");
    });
    await waitFor(() =>
      expect(useFileWindowStore.getState().tabs[0].saveStatus).toBe("saving"),
    );
    act(() => {
      void result.current.save("b");
    });
    await act(async () => {
      resolveWrite!({ absPath: "/x/a.md", mtime: 1 });
    });
    await waitFor(() =>
      expect(useFileWindowStore.getState().tabs[0].saveStatus).toBe("saved"),
    );
    // 第二次被 in-flight 门拦截：只写一次、写的是首次内容
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("workspace:writeFile", {
      workspaceId: 7,
      path: "a.md",
      content: "a",
      baselineMtime: null,
    });
  });

  it("非冲突错误：saveStatus 回 unsaved + toast 报错，不进 conflict 态", async () => {
    const tabId = openDirtyTab(1);
    invokeMock.mockRejectedValue(new Error("WORKSPACE_NOT_FOUND"));
    const { result } = renderSave(tabId);
    act(() => {
      void result.current.save("我的");
    });
    await waitFor(() =>
      expect(useFileWindowStore.getState().tabs[0].saveStatus).toBe("unsaved"),
    );
    expect(result.current.conflict).toBe(false);
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(vi.mocked(toast.error).mock.calls[0][0]).toContain(
      "WORKSPACE_NOT_FOUND",
    );
  });
});

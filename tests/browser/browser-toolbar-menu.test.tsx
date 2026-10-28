// @vitest-environment jsdom
/**
 * 工具栏 `...` 菜单组（WorkBuddy 对齐）：BrowserMoreMenu（五项 + 缩放钳制 +
 * 清除子项展开 + 禁用态）、BrowserFindBar（findInPage 命令流 + found-in-page
 * 计数回流 + Esc 清除）、BrowserDeviceBar（预设/旋转/卸载关模拟）、
 * BrowserToolbar 集成（动作经 IPC 通道上抛）。i18n 以 t→key 假体驱动
 * （文案断言走 key；zh/en 翻译本身由 locale 文件覆盖）。
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({
  toast: { success: toastSuccess, error: toastError },
}));
const invokeMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/ipc", () => ({ invoke: invokeMock, send: vi.fn() }));

import BrowserMoreMenu from "@/domains/ai/browser/components/BrowserMoreMenu";
import BrowserFindBar from "@/domains/ai/browser/components/BrowserFindBar";
import BrowserDeviceBar from "@/domains/ai/browser/components/BrowserDeviceBar";
import BrowserToolbar from "@/domains/ai/browser/components/BrowserToolbar";
import type { BrowserTab } from "@/domains/ai/browser/store/browser.store";

beforeEach(() => {
  invokeMock.mockClear();
  toastSuccess.mockClear();
  toastError.mockClear();
  // W3C 剪贴板假体（jsdom 无 navigator.clipboard/ClipboardItem；截图链路
  // 在渲染层写剪贴板——Electron 44 主进程无 writeImage）
  const clipboardWrite = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", {
    value: { write: clipboardWrite },
    configurable: true,
  });
  const items: unknown[] = [];
  (globalThis as Record<string, unknown>).ClipboardItem = class {
    constructor(payload: unknown) {
      items.push(payload);
    }
  };
  lastClipboardItems = items;
  lastClipboardWrite = clipboardWrite;
});
afterEach(cleanup);

let lastClipboardWrite: ReturnType<typeof vi.fn> = vi.fn();
let lastClipboardItems: unknown[] = [];

/* ─────────────── BrowserMoreMenu ─────────────── */

type MenuProps = Parameters<typeof BrowserMoreMenu>[0];

function renderMenu(props: Partial<MenuProps> = {}) {
  const base: MenuProps = {
    pageReady: true,
    zoomFactor: 1,
    onZoomChange: vi.fn(),
    onFindInPage: vi.fn(),
    deviceBarVisible: false,
    onToggleDeviceBar: vi.fn(),
    onScreenshot: vi.fn(),
    onClearData: vi.fn(),
    onOpenExternal: vi.fn(),
    ...props,
  };
  render(<BrowserMoreMenu {...base} />);
  return base;
}

function openMenu() {
  fireEvent.click(
    screen.getByRole("button", { name: "chat:browser.moreMenu" }),
  );
}

describe("BrowserMoreMenu", () => {
  it("打开菜单：五项 + 缩放行可见（WorkBuddy 顺序）", () => {
    renderMenu();
    openMenu();
    for (const key of [
      "findInPage",
      "zoomLabel",
      "deviceToolbar",
      "captureScreenshot",
      "clearDataMenu",
      "openExternal",
    ]) {
      expect(screen.getByText(`chat:browser.${key}`)).toBeTruthy();
    }
    expect(screen.getByText("100%")).toBeTruthy();
  });

  it("缩放：+/- 步进 10%、点百分比重置、两端钳制", () => {
    const { onZoomChange } = renderMenu({ zoomFactor: 1 });
    openMenu();
    fireEvent.click(
      screen.getByRole("button", { name: "chat:browser.zoomIn" }),
    );
    expect(onZoomChange).toHaveBeenLastCalledWith(1.1);
    fireEvent.click(
      screen.getByRole("button", { name: "chat:browser.zoomOut" }),
    );
    expect(onZoomChange).toHaveBeenLastCalledWith(0.9);
    fireEvent.click(screen.getByText("100%"));
    expect(onZoomChange).toHaveBeenLastCalledWith(1);
  });

  it("钳制：0.25 减不动、5 加不动", () => {
    const { onZoomChange } = renderMenu({ zoomFactor: 0.25 });
    openMenu();
    fireEvent.click(
      screen.getByRole("button", { name: "chat:browser.zoomOut" }),
    );
    expect(onZoomChange).toHaveBeenLastCalledWith(0.25);
    cleanup();
    const props = renderMenu({ zoomFactor: 5 });
    openMenu();
    fireEvent.click(
      screen.getByRole("button", { name: "chat:browser.zoomIn" }),
    );
    expect(props.onZoomChange).toHaveBeenLastCalledWith(5);
  });

  it("查找项：回调上抛并收菜单", () => {
    const { onFindInPage } = renderMenu();
    openMenu();
    fireEvent.click(screen.getByText("chat:browser.findInPage"));
    expect(onFindInPage).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("chat:browser.findInPage")).toBeNull();
  });

  it("清除浏览数据：展开子项后动手（cache 语义直传）并收菜单", () => {
    const { onClearData } = renderMenu();
    openMenu();
    fireEvent.click(screen.getByText("chat:browser.clearDataMenu"));
    fireEvent.click(screen.getByText("chat:browser.clearCache"));
    expect(onClearData).toHaveBeenCalledWith("cache");
    expect(screen.queryByText("chat:browser.clearCache")).toBeNull();
  });

  it("pageReady=false：guest 依赖项禁用，缩放行仍可用（tab 态不依赖 guest）", () => {
    const { onZoomChange } = renderMenu({ pageReady: false });
    openMenu();
    for (const key of [
      "findInPage",
      "deviceToolbar",
      "captureScreenshot",
      "openExternal",
    ]) {
      expect(
        (
          screen.getByRole("button", {
            name: `chat:browser.${key}`,
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
    }
    fireEvent.click(
      screen.getByRole("button", { name: "chat:browser.zoomIn" }),
    );
    expect(onZoomChange).toHaveBeenCalled();
  });
});

/* ─────────────── BrowserFindBar ─────────────── */

interface NodeStub extends HTMLElement {
  findInPage: ReturnType<typeof vi.fn>;
  stopFindInPage: ReturnType<typeof vi.fn>;
  listeners: Map<string, (e: { detail: unknown }) => void>;
}

/** webview 节点假体（原生事件监听捕获，found-in-page 可直驱） */
function stubNode(): NodeStub {
  const stub = {
    findInPage: vi.fn(),
    stopFindInPage: vi.fn(),
    listeners: new Map<string, (e: { detail: unknown }) => void>(),
  } as unknown as NodeStub;
  stub.addEventListener = ((ev: string, fn: (e: never) => void) => {
    stub.listeners.set(ev, fn as (e: { detail: unknown }) => void);
  }) as HTMLElement["addEventListener"];
  stub.removeEventListener = ((ev: string) => {
    stub.listeners.delete(ev);
  }) as HTMLElement["removeEventListener"];
  return stub;
}

describe("BrowserFindBar", () => {
  it("输入即搜（findNext=false 首搜）；Enter 步进 findNext=true；Shift+Enter 反向", () => {
    const node = stubNode();
    render(<BrowserFindBar getWebviewNode={() => node} onClose={vi.fn()} />);
    const input = screen.getByPlaceholderText("chat:browser.findInPage");
    fireEvent.change(input, { target: { value: "abc" } });
    expect(node.findInPage).toHaveBeenCalledWith("abc", {
      forward: true,
      findNext: false,
      matchCase: false,
    });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(node.findInPage).toHaveBeenLastCalledWith("abc", {
      forward: true,
      findNext: true,
      matchCase: false,
    });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(node.findInPage).toHaveBeenLastCalledWith("abc", {
      forward: false,
      findNext: true,
      matchCase: false,
    });
  });

  it("found-in-page 计数回流：显示 第n/共m", () => {
    const node = stubNode();
    render(<BrowserFindBar getWebviewNode={() => node} onClose={vi.fn()} />);
    act(() => {
      node.listeners.get("found-in-page")!({
        detail: { activeMatchOrdinal: 2, matches: 5 },
      });
    });
    expect(screen.getByText("2/5")).toBeTruthy();
  });

  it("Esc / 清空输入：清高亮（clearSelection）", () => {
    const node = stubNode();
    const onClose = vi.fn();
    render(<BrowserFindBar getWebviewNode={() => node} onClose={onClose} />);
    const input = screen.getByPlaceholderText("chat:browser.findInPage");
    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(node.stopFindInPage).toHaveBeenCalledWith("clearSelection");
    expect(onClose).toHaveBeenCalledTimes(1);
    // 清空输入同样清高亮（重开后残留高亮消除）
    fireEvent.change(input, { target: { value: "" } });
    expect(node.stopFindInPage).toHaveBeenCalledTimes(2);
  });
});

/* ─────────────── BrowserDeviceBar ─────────────── */

function nodeWithWcId(id = 42): HTMLElement {
  return {
    getWebContentsId: () => id,
    // 元素可视区（设备模拟 fit scale 的 avail 上报源）
    getBoundingClientRect: () => ({ width: 800, height: 600, x: 0, y: 0 }),
  } as unknown as HTMLElement;
}

describe("BrowserDeviceBar", () => {
  it("挂载默认手机预设 → enableDeviceEmulation（含 avail 上报）", () => {
    render(
      <BrowserDeviceBar
        getWebviewNode={() => nodeWithWcId()}
        onClose={vi.fn()}
      />,
    );
    expect(invokeMock).toHaveBeenCalledWith("browser:emulateDevice", 42, {
      width: 375,
      height: 667,
      deviceScaleFactor: 2,
      screenPosition: "mobile",
      availWidth: 800,
      availHeight: 600,
    });
  });

  it("换平板并旋转 → 尺寸互换重放", () => {
    render(
      <BrowserDeviceBar
        getWebviewNode={() => nodeWithWcId()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "tablet" },
    });
    expect(invokeMock).toHaveBeenLastCalledWith("browser:emulateDevice", 42, {
      width: 768,
      height: 1024,
      deviceScaleFactor: 2,
      screenPosition: "mobile",
      availWidth: 800,
      availHeight: 600,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "chat:browser.deviceRotate" }),
    );
    expect(invokeMock).toHaveBeenLastCalledWith("browser:emulateDevice", 42, {
      width: 1024,
      height: 768,
      deviceScaleFactor: 2,
      screenPosition: "mobile",
      availWidth: 800,
      availHeight: 600,
    });
  });

  it("卸载 → 关模拟（null）；guest 已失联则静默不再发", () => {
    const node = nodeWithWcId();
    const { unmount } = render(
      <BrowserDeviceBar getWebviewNode={() => node} onClose={vi.fn()} />,
    );
    unmount();
    expect(invokeMock).toHaveBeenLastCalledWith(
      "browser:emulateDevice",
      42,
      null,
    );
  });
});

/* ─────────────── BrowserToolbar 集成 ─────────────── */

function makeTab(url: string): BrowserTab {
  return {
    id: "t1",
    url,
    title: "",
    favicon: "",
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
  };
}

function renderToolbar(url = "https://example.com/") {
  const onSync = vi.fn();
  const node = {
    getWebContentsId: () => 42,
    reload: vi.fn(),
    findInPage: vi.fn(),
    stopFindInPage: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    getBoundingClientRect: () => ({ width: 800, height: 600, x: 0, y: 0 }),
  } as unknown as HTMLElement;
  render(
    <BrowserToolbar
      tab={makeTab(url)}
      getWebviewNode={() => node}
      onSync={onSync}
    />,
  );
  return { onSync };
}

describe("BrowserToolbar 集成", () => {
  it("菜单查找项 → 打开查找条；Esc 关闭", () => {
    renderToolbar();
    openMenu();
    fireEvent.click(screen.getByText("chat:browser.findInPage"));
    const input = screen.getByPlaceholderText("chat:browser.findInPage");
    expect(input).toBeTruthy();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByPlaceholderText("chat:browser.findInPage")).toBeNull();
  });

  it("缩放经 onSync 上抛 tab 态", () => {
    const { onSync } = renderToolbar();
    openMenu();
    fireEvent.click(
      screen.getByRole("button", { name: "chat:browser.zoomIn" }),
    );
    expect(onSync).toHaveBeenCalledWith({ zoomFactor: 1.1 });
  });

  it("截图 → IPC 取 dataURL + 渲染层写 W3C 剪贴板 + 成功 toast", async () => {
    invokeMock.mockResolvedValueOnce("data:image/png;base64,QUJD");
    renderToolbar();
    openMenu();
    fireEvent.click(screen.getByText("chat:browser.captureScreenshot"));
    expect(invokeMock).toHaveBeenCalledWith("browser:captureScreenshot", 42);
    await vi.waitFor(() => {
      expect(lastClipboardWrite).toHaveBeenCalledTimes(1);
      expect(toastSuccess).toHaveBeenCalledWith(
        "chat:browser.screenshotCopied",
      );
    });
    // ClipboardItem 载荷为 PNG Blob
    const payload = lastClipboardItems[0] as Record<string, Blob>;
    expect(payload["image/png"]).toBeInstanceOf(Blob);
    expect(payload["image/png"].type).toBe("image/png");
  });

  it("外部浏览器打开 → IPC 传当前 url", () => {
    renderToolbar("https://example.com/page?q=1");
    openMenu();
    fireEvent.click(screen.getByText("chat:browser.openExternal"));
    expect(invokeMock).toHaveBeenCalledWith(
      "browser:openExternal",
      "https://example.com/page?q=1",
    );
  });

  it("设备工具栏开关：经菜单开出设备行", () => {
    renderToolbar();
    openMenu();
    fireEvent.click(screen.getByText("chat:browser.deviceToolbar"));
    expect(screen.getByRole("combobox")).toBeTruthy();
  });
});

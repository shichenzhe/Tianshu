// init-updater 直测：dev 态回发 update-not-available 且不触碰更新器；
// packaged 态读打包元数据（app-update.yml）检查更新并注册事件回发。
// electron / electron-updater 全 mock（无 dev-app-update.yml 调测配置）。
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ isPackaged: false }));
const sends: string[] = [];

vi.mock("electron", () => ({
  BrowserWindow: class {},
  app: {
    get isPackaged() {
      return state.isPackaged;
    },
  },
  ipcMain: { on: vi.fn() },
}));
vi.mock("electron-updater", () => ({
  autoUpdater: {
    checkForUpdates: vi.fn(() => Promise.resolve()),
    on: vi.fn(),
    autoDownload: false,
    logger: null,
  },
}));
vi.mock("../../electron/commons/Log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ipcMain } from "electron";
import { autoUpdater } from "electron-updater";
import { initUpdater } from "../../electron/init-updater";

const makeWin = () =>
  ({
    webContents: { send: (c: string) => sends.push(c) },
  }) as never;

beforeEach(() => {
  state.isPackaged = false;
  sends.length = 0;
  vi.mocked(autoUpdater.checkForUpdates).mockClear();
  vi.mocked(autoUpdater.on).mockClear();
});

describe("initUpdater", () => {
  it("开发态：IPC 检查更新回发 update-not-available，不初始化更新器", () => {
    initUpdater(makeWin());
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(autoUpdater.on).not.toHaveBeenCalled();
    const handler = vi
      .mocked(ipcMain.on)
      .mock.calls.find((c) => c[0] === "check-for-updates")?.[1] as () => void;
    handler();
    expect(sends).toEqual(["update-not-available"]);
  });

  it("打包态：检查更新并注册事件回发", () => {
    state.isPackaged = true;
    initUpdater(makeWin());
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    const events = vi.mocked(autoUpdater.on).mock.calls.map((c) => c[0]);
    expect(events).toEqual(
      expect.arrayContaining([
        "update-not-available",
        "update-available",
        "error",
        "download-progress",
        "update-downloaded",
      ]),
    );
  });

  it("打包态 check-for-updates IPC：再次触发检查", () => {
    state.isPackaged = true;
    initUpdater(makeWin());
    vi.mocked(autoUpdater.checkForUpdates).mockClear();
    const handler = vi
      .mocked(ipcMain.on)
      .mock.calls.find((c) => c[0] === "check-for-updates")?.[1] as () => void;
    handler();
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  });
});

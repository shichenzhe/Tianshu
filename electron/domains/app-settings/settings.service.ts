/**
 * 设置服务（通用设置面板后端）：option 表持久化（type="app"）+ 系统能力桥接。
 * 通道：getAll/set（app 设置项 upsert）、getAutoLaunch/setAutoLaunch（开机自启，
 * OS 登录项为唯一事实源）、getKeepAwake/setKeepAwake（防休眠，powerSaveBlocker
 * 幂等起停 + 偏好持久化）、setProxy（代理，Electron session + 主进程 undici 双层，
 * 持久化供启动重放）、storageInfo（userData 递归占用 + statfs 磁盘）、
 * pickDirectory/openDirectory（目录选择与打开，打开前 stat 校验仅放行目录）、
 * getRunRetention/setRunRetention（自动化执行历史保留，option 行
 * patch 合并持久化）、beep（提示音）、
 * openExternal（白名单外部地址跳转，当前仅系统通知授权设置页）、
 * testNotification（测试通知，主进程 Notification：未签名 dev 下渲染层
 * 通知被 macOS 静默丢弃且 permission 谎报 granted，故收口到主进程）。
 * 注：本域目录名为 app-settings（settings 目录名被本地权限规则拒绝，功能不受影响）。
 */
import {
  app,
  dialog,
  ipcMain,
  Notification,
  powerSaveBlocker,
  session,
  shell,
} from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import prisma from "../../commons/prisma-client";
import { tianshuRoot, defaultTianshuRoot } from "../../commons/paths";
import { writeConfiguredDataRoot } from "../../commons/data-root-config";
import Log from "../../commons/Log";
import {
  OPTION_NAMES,
  getAppOptionMap,
  listAppOptions,
  parseBoolOption,
  setAppOption,
  type OptionPrismaLike,
} from "./option-store";
import {
  normalizeProxyParams,
  proxyOptionsToParams,
  proxyParamsToOptions,
  toSessionProxyConfig,
  type ProxyParams,
} from "./proxy-config";
import { applyProxyDispatcher } from "./proxy-dispatcher";
import { computeDirSize, diskBytesFromStatfs } from "./storage-info";
import { isOpenExternalAllowed } from "./external-url";
import {
  parseRunRetention,
  type RunRetentionConfig,
} from "../ai/automation/automation-retention";

/** 执行历史保留配置落 option 表的设置名（Task 1 裁定：automation.runRetention） */
const RUN_RETENTION_OPTION = "automation.runRetention";

export interface StorageInfo {
  /** 用户数据目录绝对路径 */
  userDataPath: string;
  /** userData 目录递归占用（字节） */
  cacheBytes: number;
  /** 所在磁盘卷总量（字节；statfs 失败时为 0） */
  diskTotal: number;
  /** 所在磁盘卷可用（字节；statfs 失败时为 0） */
  diskFree: number;
}

/** 数据根状态（设置面板「数据目录」块） */
export interface DataRootInfo {
  /** 当前生效根（env 覆盖 > 用户配置 > 默认 ~/.tianshu） */
  current: string;
  /** 默认根（未自定义时的基准） */
  defaultRoot: string;
  /** 当前是否为用户自定义根 */
  isCustom: boolean;
}

/** target 是否位于 root 目录之内（严格子路径，含平台分隔符边界） */
function isPathInside(target: string, root: string): boolean {
  return target.startsWith(root + path.sep);
}

/** 目录校验：不存在或非目录（可执行文件/符号链接指向文件等）均为假 */
async function isDirectory(targetPath: string): Promise<boolean> {
  try {
    return (await fs.stat(targetPath)).isDirectory();
  } catch {
    return false;
  }
}

export default class SettingsService {
  /** 防休眠阻断器 id（未启用为 null）：幂等起停与退出清理的依据 */
  private blockerId: number | null = null;

  constructor() {
    this.registerHandlers();
    // 退出时显式释放防休眠阻断，避免跨会话泄漏
    app.on("quit", () => this.stopKeepAwake());
  }

  private registerHandlers() {
    ipcMain.handle("settings:getAll", () => listAppOptions(this.db));
    ipcMain.handle(
      "settings:set",
      (_, name: string, value: string): Promise<void> =>
        setAppOption(this.db, name, value),
    );
    // webhook 全局端口：专用通道承载试绑与占用回滚（通用 set 只写
    // option 不重绑）；get 返回当前生效端口（未配置回落默认）
    ipcMain.handle("settings:getWebhookPort", async (): Promise<number> => {
      const { getWebhookPort } =
        await import("../ai/orchestration/webhook-server");
      return getWebhookPort();
    });
    ipcMain.handle(
      "settings:setWebhookPort",
      async (_, port: number): Promise<number> => {
        const { setWebhookPort } =
          await import("../ai/orchestration/webhook-server");
        return setWebhookPort(port);
      },
    );
    // 执行历史保留：读缺省/畸形回默认；patch 合并当前值后整行 JSON upsert
    ipcMain.handle(
      "settings:getRunRetention",
      (): Promise<RunRetentionConfig> => this.getRunRetention(),
    );
    ipcMain.handle(
      "settings:setRunRetention",
      (_, patch: Partial<RunRetentionConfig>): Promise<void> =>
        this.setRunRetention(patch),
    );
    ipcMain.handle("settings:getAutoLaunch", () => this.getAutoLaunch());
    ipcMain.handle(
      "settings:setAutoLaunch",
      (_, enabled: boolean): Promise<void> => this.setAutoLaunch(enabled),
    );
    ipcMain.handle("settings:getKeepAwake", () => this.getKeepAwake());
    ipcMain.handle(
      "settings:setKeepAwake",
      (_, enabled: boolean): Promise<void> => this.setKeepAwake(enabled),
    );
    ipcMain.handle(
      "settings:setProxy",
      (_, mode: unknown, host?: unknown, port?: unknown): Promise<void> =>
        this.setProxy(mode, host, port),
    );
    ipcMain.handle("settings:storageInfo", (): Promise<StorageInfo> =>
      this.storageInfo(),
    );
    ipcMain.handle("settings:getDataRoot", (): DataRootInfo =>
      this.getDataRoot(),
    );
    ipcMain.handle(
      "settings:setDataRoot",
      (_, value: string | null): DataRootInfo => this.setDataRoot(value),
    );
    ipcMain.handle("settings:relaunchApp", (): void => {
      app.relaunch();
      app.exit(0);
    });
    ipcMain.handle("settings:pickDirectory", (): Promise<string | null> =>
      this.pickDirectory(),
    );
    ipcMain.handle(
      "settings:openDirectory",
      (_, targetPath: string): Promise<void> => this.openDirectory(targetPath),
    );
    ipcMain.handle("settings:beep", () => shell.beep());
    ipcMain.handle("settings:openExternal", (_, url: unknown): Promise<void> =>
      this.openExternal(url),
    );
    ipcMain.handle(
      "settings:testNotification",
      (_, title: string, body: string): void =>
        this.testNotification(title, body),
    );
  }

  /** option 表 delegate（类型收窄到结构子集，便于测试注入） */
  private get db(): OptionPrismaLike {
    return prisma.option;
  }

  /** 开机自启：OS 登录项为唯一事实源（能感知用户在系统层的改动），不另存 option */
  getAutoLaunch(): boolean {
    return app.getLoginItemSettings().openAtLogin;
  }

  async setAutoLaunch(enabled: boolean): Promise<void> {
    app.setLoginItemSettings({ openAtLogin: enabled });
  }

  /** 防休眠状态：存在活动阻断器即开启 */
  getKeepAwake(): boolean {
    return (
      this.blockerId !== null && powerSaveBlocker.isStarted(this.blockerId)
    );
  }

  /** 防休眠起停（幂等）+ 偏好持久化（重启后由 restorePersistedSettings 重放） */
  async setKeepAwake(enabled: boolean): Promise<void> {
    if (enabled) {
      this.startKeepAwake();
    } else {
      this.stopKeepAwake();
    }
    await setAppOption(this.db, OPTION_NAMES.keepAwake, String(enabled));
  }

  private startKeepAwake(): void {
    if (this.getKeepAwake()) {
      return;
    }
    this.blockerId = powerSaveBlocker.start("prevent-display-sleep");
  }

  /** 已停/未启用均为空操作；清空 id 使后续 start 不受陈旧 id 干扰 */
  private stopKeepAwake(): void {
    if (this.blockerId === null) {
      return;
    }
    if (powerSaveBlocker.isStarted(this.blockerId)) {
      powerSaveBlocker.stop(this.blockerId);
    }
    this.blockerId = null;
  }

  /** 设置代理：校验 → 应用（session + 主进程 dispatcher）→ 持久化（供启动重放） */
  async setProxy(mode: unknown, host?: unknown, port?: unknown): Promise<void> {
    const check = normalizeProxyParams({ mode, host, port });
    if (!check.ok) {
      throw new Error(check.error);
    }
    await this.applyProxy(check.params);
    await this.persistProxy(check.params);
  }

  /** 应用代理：Electron 会话（渲染层）+ 主进程 Node fetch（模型 API、skillhub 等） */
  private async applyProxy(params: ProxyParams): Promise<void> {
    await session.defaultSession.setProxy(toSessionProxyConfig(params));
    applyProxyDispatcher(params);
  }

  private async persistProxy(params: ProxyParams): Promise<void> {
    for (const item of proxyParamsToOptions(params)) {
      await setAppOption(this.db, item.name, item.value);
    }
  }

  /**
   * 启动恢复（Application 于 MCP 连接前 await 调用，失败由调用方记日志）：
   * 按持久化配置重放代理与防休眠。代理记录缺失时按 system（Chromium 缺省）
   * 应用，保证与上次会话一致的网络行为；记录畸形时降级 system 不阻塞启动。
   */
  async restorePersistedSettings(): Promise<void> {
    const map = await getAppOptionMap(this.db, [
      OPTION_NAMES.proxyMode,
      OPTION_NAMES.proxyHost,
      OPTION_NAMES.proxyPort,
      OPTION_NAMES.keepAwake,
    ]);
    await this.applyProxy(proxyOptionsToParams(map));
    if (parseBoolOption(map.get(OPTION_NAMES.keepAwake), false)) {
      this.startKeepAwake();
    }
  }

  /** 执行历史保留配置：读 option 行（缺省/畸形回 Task 1 默认） */
  async getRunRetention(): Promise<RunRetentionConfig> {
    const map = await getAppOptionMap(this.db, [RUN_RETENTION_OPTION]);
    return parseRunRetention(map.get(RUN_RETENTION_OPTION));
  }

  /**
   * 改执行历史保留配置：patch 合并当前值（undefined 键过滤——防部分
   * 提交把 JSON.stringify 后的其余字段抹掉）后整行 upsert。
   */
  async setRunRetention(patch: Partial<RunRetentionConfig>): Promise<void> {
    const current = await this.getRunRetention();
    const clean = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    );
    const next = { ...current, ...clean };
    await setAppOption(this.db, RUN_RETENTION_OPTION, JSON.stringify(next));
  }

  /** 存储信息：~/.tianshu 数据根递归占用 + 所在卷总量/可用（statfs 失败降级 0 并记日志） */
  async storageInfo(): Promise<StorageInfo> {
    const userDataPath = tianshuRoot();
    return {
      userDataPath,
      cacheBytes: await computeDirSize(fs, userDataPath),
      ...(await this.diskBytes(userDataPath)),
    };
  }

  /** 数据根状态：当前生效根 + 默认根 + 是否自定义（设置面板展示） */
  getDataRoot(): DataRootInfo {
    const def = defaultTianshuRoot();
    const current = tianshuRoot();
    return { current, defaultRoot: def, isCustom: current !== def };
  }

  /**
   * 写入/清除自定义数据根配置（重启生效——数据库须冷迁移，运行中不
   * 可搬）。防护：必须绝对路径；不允许落在当前根或默认根之内（防新旧
   * 数据混淆与迁移自拷）。配置写 userData/data-root.json（库外，见
   * data-root-config.ts 头注释）。
   */
  setDataRoot(value: string | null): DataRootInfo {
    if (value !== null) {
      if (!path.isAbsolute(value)) {
        throw new Error("DATA_ROOT_MUST_BE_ABSOLUTE");
      }
      const normalized = path.normalize(value);
      const def = defaultTianshuRoot();
      const forbiddenRoots = [tianshuRoot(), def];
      if (
        forbiddenRoots.some(
          (root) => normalized !== root && isPathInside(normalized, root),
        )
      ) {
        throw new Error("DATA_ROOT_NESTED");
      }
      writeConfiguredDataRoot(normalized);
    } else {
      writeConfiguredDataRoot(null);
    }
    return this.getDataRoot();
  }

  private async diskBytes(
    targetPath: string,
  ): Promise<{ diskTotal: number; diskFree: number }> {
    try {
      return diskBytesFromStatfs(await fs.statfs(targetPath));
    } catch (e) {
      Log.warn("存储信息 statfs 失败", e instanceof Error ? e.message : e);
      return { diskTotal: 0, diskFree: 0 };
    }
  }

  /** 系统目录选择；取消返回 null（渲染层静默处理，参照 workspace:bindDirectory） */
  async pickDirectory(): Promise<string | null> {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
    });
    return result.canceled || result.filePaths.length === 0
      ? null
      : result.filePaths[0];
  }

  /** 打开目录（先 stat 校验为目录——防 .app/.exe 等任意路径借默认处理器执行；
   * openPath 失败 resolve 错误串——转 reject 让渲染层 toast） */
  async openDirectory(targetPath: string): Promise<void> {
    if (!targetPath) {
      throw new Error("EMPTY_PATH");
    }
    if (!(await isDirectory(targetPath))) {
      throw new Error("INVALID_DIRECTORY");
    }
    const openError = await shell.openPath(targetPath);
    if (openError) {
      throw new Error(openError);
    }
  }

  /** 打开白名单外部地址（当前仅系统通知授权设置页；白名单外拒绝防任意跳转） */
  async openExternal(url: unknown): Promise<void> {
    if (!isOpenExternalAllowed(url)) {
      throw new Error("OPEN_EXTERNAL_FORBIDDEN");
    }
    await shell.openExternal(url as string);
  }

  /**
   * 发送测试桌面通知（主进程 Electron Notification：macOS 未签名 dev 应用
   * 的渲染层通知被系统静默丢弃，生产打包签名后主进程路径确定可用）；
   * 系统不支持时抛错误码让渲染层给出可见反馈。
   */
  testNotification(title: string, body: string): void {
    if (!Notification.isSupported()) {
      throw new Error("TEST_NOTIFICATION_UNSUPPORTED");
    }
    new Notification({ title, body }).show();
  }
}

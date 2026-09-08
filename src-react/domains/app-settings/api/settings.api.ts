/**
 * 设置 API（类型供设置面板各分组使用）
 * 通道由主进程 SettingsService 提供（electron/domains/app-settings/settings.service.ts）
 */

import { invoke } from "@/lib/ipc";

/** 单条应用设置键值 */
export interface SettingItem {
  name: string;
  value: string;
}

/** 代理模式：直连 / 跟随系统 / 手动代理 */
export type ProxyMode = "direct" | "system" | "proxy";

/** 存储信息：userData 目录递归大小 + 磁盘总量/剩余 */
export interface StorageInfo {
  userDataPath: string;
  cacheBytes: number;
  diskTotal: number;
  diskFree: number;
}

export class SettingsApi {
  /** 全量应用设置键值（option 表 type="app"） */
  static async getAll(): Promise<SettingItem[]> {
    return invoke<SettingItem[]>("settings:getAll");
  }

  /** upsert 单条应用设置 */
  static async set(name: string, value: string): Promise<void> {
    return invoke<void>("settings:set", name, value);
  }

  /** 开机自启状态（OS 登录项为唯一事实源） */
  static async getAutoLaunch(): Promise<boolean> {
    return invoke<boolean>("settings:getAutoLaunch");
  }

  /** 设置开机自启 */
  static async setAutoLaunch(enabled: boolean): Promise<void> {
    return invoke<void>("settings:setAutoLaunch", enabled);
  }

  /** 防休眠状态（活动 powerSaveBlocker 即 true） */
  static async getKeepAwake(): Promise<boolean> {
    return invoke<boolean>("settings:getKeepAwake");
  }

  /** 启停防休眠 */
  static async setKeepAwake(enabled: boolean): Promise<void> {
    return invoke<void>("settings:setKeepAwake", enabled);
  }

  /** 设置代理（mode=proxy 时 host/port 必填） */
  static async setProxy(
    mode: ProxyMode,
    host?: string,
    port?: number,
  ): Promise<void> {
    return invoke<void>("settings:setProxy", mode, host, port);
  }

  /** 存储信息（userData 大小 + 磁盘总量/剩余） */
  static async storageInfo(): Promise<StorageInfo> {
    return invoke<StorageInfo>("settings:storageInfo");
  }

  /** 选择目录（取消返回 null） */
  static async pickDirectory(): Promise<string | null> {
    return invoke<string | null>("settings:pickDirectory");
  }

  /** 系统文件管理器打开目录 */
  static async openDirectory(targetPath: string): Promise<void> {
    return invoke<void>("settings:openDirectory", targetPath);
  }

  /** 系统提示音 */
  static async beep(): Promise<void> {
    return invoke<void>("settings:beep");
  }
}

export default SettingsApi;

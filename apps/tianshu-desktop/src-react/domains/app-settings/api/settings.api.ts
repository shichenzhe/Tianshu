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

/** 数据根状态（设置面板「数据目录」块）：当前生效根 + 默认根 */
export interface DataRootInfo {
  current: string;
  defaultRoot: string;
  isCustom: boolean;
}

/**
 * 执行历史保留配置（契约内联：六字段与主进程 RunRetentionConfig 同名，
 * 不跨层 import electron 文件——GA-T3 先例）
 */
export interface RunRetentionSetting {
  enabled: boolean;
  traceDays: number;
  successDays: number;
  successKeep: number;
  failureDays: number;
  failureKeep: number;
}

export class SettingsApi {
  /** 全量应用设置键值（option 表 type="app"） */
  static async getAll(): Promise<SettingItem[]> {
    return invoke<SettingItem[]>("settings:getAll");
  }

  /** webhook 服务当前生效端口（纯读不拉起服务） */
  static async getWebhookPort(): Promise<number> {
    return invoke<number>("settings:getWebhookPort");
  }

  /** 设置 webhook 全局端口（立即重绑；被占用时后端回滚并抛错） */
  static async setWebhookPort(port: number): Promise<number> {
    return invoke<number>("settings:setWebhookPort", port);
  }

  /** 执行历史保留配置（缺省/畸形后端回默认） */
  static async getRunRetention(): Promise<RunRetentionSetting> {
    return invoke<RunRetentionSetting>("settings:getRunRetention");
  }

  /** 改执行历史保留配置（patch 合并当前值持久化） */
  static async setRunRetention(
    config: Partial<RunRetentionSetting>,
  ): Promise<void> {
    return invoke<void>("settings:setRunRetention", config);
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

  /** 存储信息（数据根大小 + 磁盘总量/剩余） */
  static async storageInfo(): Promise<StorageInfo> {
    return invoke<StorageInfo>("settings:storageInfo");
  }

  /** 数据根状态（当前/默认/是否自定义） */
  static async getDataRoot(): Promise<DataRootInfo> {
    return invoke<DataRootInfo>("settings:getDataRoot");
  }

  /** 写入/清除自定义数据根（null 恢复默认）；重启后生效 */
  static async setDataRoot(value: string | null): Promise<DataRootInfo> {
    return invoke<DataRootInfo>("settings:setDataRoot", value);
  }

  /** 重启应用（自定义数据根生效） */
  static async relaunchApp(): Promise<void> {
    return invoke<void>("settings:relaunchApp");
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

  /** 打开白名单外部地址（当前仅系统通知授权设置页） */
  static async openExternal(url: string): Promise<void> {
    return invoke<void>("settings:openExternal", url);
  }

  /** 发送测试桌面通知（主进程 Notification；渲染层在未签名 dev 下不可靠） */
  static async testNotification(title: string, body: string): Promise<void> {
    return invoke<void>("settings:testNotification", title, body);
  }
}

export default SettingsApi;

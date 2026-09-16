/**
 * 安全配置服务（SP1 spec §6.1）：内存缓存 + 写时失效。
 * 读走缓存零 DB 开销（SP2-SP6 执行层消费）；写 = normalize → 剔内置 →
 * upsert option → 更新缓存 → 审计 config.<key>.updated。
 */
import { app, ipcMain, shell } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import prisma from "../../commons/prisma-client";
import type {
  SecurityConfig,
  SecurityConfigKey,
  SecurityConfigState,
  SecurityEventSink,
} from "../../../src-react/domains/security/model/types";
import {
  copySecurityConfig,
  listSecurityOptions,
  normalizeBulkDeleteThreshold,
  normalizeFileBackupMaxSizeMB,
  parseSecurityConfig,
  pickCommandRuleArray,
  pickDomainArray,
  pickStringArray,
  serializeSecurityValue,
  setSecurityOption,
  stripBuiltinItems,
  type SecurityOptionPrismaLike,
} from "./config-store";
import {
  BUILTIN_MALICIOUS_DOMAINS,
  SECURITY_DEFAULTS,
  defaultFileBlocklist,
} from "./defaults";

/** 各 key 写入时的校验/清洗：bool 严格真、名单重校验、数值钳制 */
const NORMALIZERS: Record<SecurityConfigKey, (v: unknown) => unknown> = {
  sandboxEnabled: (v) => v === true,
  blockAllNetwork: (v) => v === true,
  maliciousDomainProtection: (v) => v === true,
  fileBackupEnabled: (v) => v === true,
  deleteProtection: (v) => v === true,
  fileAllowlist: pickStringArray,
  fileBlocklist: pickStringArray,
  programBlacklist: pickStringArray,
  domainAllow: pickDomainArray,
  domainDeny: pickDomainArray,
  cmdAllow: pickCommandRuleArray,
  cmdAsk: pickCommandRuleArray,
  fileBackupMaxSizeMB: normalizeFileBackupMaxSizeMB,
  bulkDeleteThreshold: normalizeBulkDeleteThreshold,
};

export default class SecurityService {
  private config: SecurityConfig = copySecurityConfig(SECURITY_DEFAULTS);
  private builtinBlocklist = defaultFileBlocklist(process.platform);

  constructor(
    private opts: {
      db?: SecurityOptionPrismaLike;
      audit?: SecurityEventSink;
      onConfigChange?: (key: SecurityConfigKey) => void;
    } = {},
  ) {
    this.registerHandlers();
  }

  private get db(): SecurityOptionPrismaLike {
    return this.opts.db ?? prisma.option;
  }

  /** 启动加载：option 行 → read-time fallback → 内存缓存 */
  async init(): Promise<void> {
    const rows = await listSecurityOptions(this.db);
    this.config = parseSecurityConfig(rows);
    // 装配侧读取全部网络配置后决策（key 仅作触发器）
    this.opts.onConfigChange?.("sandboxEnabled");
  }

  /** 读接口（含内置清单分离，spec §5.2） */
  getConfig(): SecurityConfigState {
    return {
      defaults: {
        fileBlocklist: [...this.builtinBlocklist],
        maliciousDomains: [...BUILTIN_MALICIOUS_DOMAINS],
      },
      config: copySecurityConfig(this.config),
    };
  }

  /** 执行层便捷读（SP2-SP6 消费，纯内存） */
  getConfigValue(): SecurityConfig {
    return copySecurityConfig(this.config);
  }

  /** 单 key 写：校验 → 剔内置 → upsert → 缓存 → 审计 */
  async setConfig(
    key: SecurityConfigKey,
    value: unknown,
  ): Promise<SecurityConfig> {
    if (!(key in SECURITY_DEFAULTS)) {
      throw new Error(`未知安全配置项: ${key}`);
    }
    const normalized = NORMALIZERS[key](value);
    const cleaned = this.cleanValue(key, normalized);
    await setSecurityOption(this.db, key, serializeSecurityValue(key, cleaned));
    (this.config as Record<SecurityConfigKey, unknown>)[key] = cleaned;
    this.opts.onConfigChange?.(key);
    this.opts.audit?.({
      eventType: `config.${key}.updated`,
      decision: "info",
      detail: { key, value: cleaned },
    });
    return copySecurityConfig(this.config);
  }

  /** 三名单恢复默认（spec §7）：逐 key 走 setConfig（各发 updated 审计）+ 一条 reset 事件 */
  async resetCommandRules(): Promise<SecurityConfig> {
    const keys: SecurityConfigKey[] = [
      "programBlacklist",
      "cmdAllow",
      "cmdAsk",
    ];
    let config = this.getConfigValue();
    for (const key of keys) {
      config = await this.setConfig(key, SECURITY_DEFAULTS[key]);
    }
    this.opts.audit?.({
      eventType: "config.commandRules.reset",
      decision: "info",
      detail: { keys },
    });
    return copySecurityConfig(config);
  }

  /** 文件两名单恢复默认（spec §5）：用户部分重置，内置清单不受影响 */
  async resetFileRules(): Promise<SecurityConfig> {
    const keys: SecurityConfigKey[] = ["fileBlocklist", "fileAllowlist"];
    let config = this.getConfigValue();
    for (const key of keys) {
      config = await this.setConfig(key, SECURITY_DEFAULTS[key]);
    }
    this.opts.audit?.({
      eventType: "config.fileRules.reset",
      decision: "info",
      detail: { keys },
    });
    return copySecurityConfig(config);
  }

  private cleanValue(key: SecurityConfigKey, value: unknown): unknown {
    if (key === "fileBlocklist") {
      return stripBuiltinItems(value as string[], this.builtinBlocklist);
    }
    return value;
  }

  private registerHandlers(): void {
    ipcMain.handle("security:getConfig", () => this.getConfig());
    ipcMain.handle(
      "security:setConfig",
      (_, key: SecurityConfigKey, value: unknown) => this.setConfig(key, value),
    );
    ipcMain.handle(
      "security:resetCommandRules",
      async (): Promise<SecurityConfig> => this.resetCommandRules(),
    );
    ipcMain.handle(
      "security:resetFileRules",
      async (): Promise<SecurityConfig> => this.resetFileRules(),
    );
    ipcMain.handle("security:openBackupDir", async (): Promise<void> => {
      const dir = path.join(app.getPath("userData"), "file-history");
      await fs.mkdir(dir, { recursive: true });
      const openError = await shell.openPath(dir);
      if (openError) {
        throw new Error(openError);
      }
    });
  }
}

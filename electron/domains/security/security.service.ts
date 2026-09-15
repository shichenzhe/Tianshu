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
  pickStringArray,
  serializeSecurityValue,
  setSecurityOption,
  stripBuiltinItems,
  type SecurityOptionPrismaLike,
} from "./config-store";
import { SECURITY_DEFAULTS, defaultFileBlocklist } from "./defaults";

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
  domainAllow: pickStringArray,
  domainDeny: pickStringArray,
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
  }

  /** 读接口（含内置清单分离，spec §5.2） */
  getConfig(): SecurityConfigState {
    return {
      defaults: { fileBlocklist: [...this.builtinBlocklist] },
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
    this.opts.audit?.({
      eventType: `config.${key}.updated`,
      decision: "info",
      detail: { key, value: cleaned },
    });
    return copySecurityConfig(this.config);
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

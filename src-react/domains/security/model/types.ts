/**
 * 安全中心共享类型（SP1 spec §6.4）：前后端 import type 共享
 * （主进程侧参照 provider.repo.ts 的跨进程类型引入惯例）
 */

export type CmdRule = { prefix: string[]; reason?: string };

export type SecurityConfig = {
  sandboxEnabled: boolean;
  fileAllowlist: string[];
  fileBlocklist: string[];
  cmdAllow: CmdRule[];
  cmdAsk: CmdRule[];
  programBlacklist: string[];
  domainAllow: string[];
  domainDeny: string[];
  blockAllNetwork: boolean;
  maliciousDomainProtection: boolean;
  fileBackupEnabled: boolean;
  fileBackupMaxSizeMB: number;
  deleteProtection: boolean;
  bulkDeleteThreshold: number;
};

export type SecurityConfigKey = keyof SecurityConfig;

/** 读接口：内置清单（只读常量）与用户配置分离（spec §5.2） */
export type SecurityConfigState = {
  defaults: { fileBlocklist: string[]; maliciousDomains: string[] };
  config: SecurityConfig;
};

export type AuditCategory =
  "command-safety" | "file-safety" | "network" | "data-safety" | "config";

export type AuditDecision =
  "approved" | "rejected" | "blocked" | "allowed" | "failed" | "info";

export type AuditEntry = {
  id: number;
  sequence: number;
  category: AuditCategory;
  eventType: string;
  decision: AuditDecision;
  detail: string | null;
  commandPreview: string | null;
  commandHash: string | null;
  sessionId: number | null;
  prevHash: string | null;
  hash: string;
  createdAt: string;
};

export type AuditListParams = {
  page?: number;
  pageSize?: number;
  keyword?: string;
};

export type AuditListResult = {
  entries: AuditEntry[];
  total: number;
  page: number;
  pageSize: number;
};

/** 安全事件（审计写入输入）：category 由 eventType 前缀推导 */
export type SecurityEvent = {
  eventType: string;
  decision: AuditDecision;
  detail?: Record<string, unknown>;
  commandPreview?: string;
  commandHash?: string;
  sessionId?: number | null;
};

export type SecurityEventSink = (event: SecurityEvent) => void;

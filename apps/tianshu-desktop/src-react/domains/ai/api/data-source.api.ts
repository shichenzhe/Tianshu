/**
 * 数据源配置 API（PG 首选通道，切片 B 2026-10-29）：类型同时供主进程
 * repo import type。凭据面：password 只写不读——list/update 回执不含
 * password，以 hasPassword 布尔示意（编辑留空 = 不修改）。
 */

import { invoke } from "@/lib/ipc";

export interface DataSourceRecord {
  id: number;
  name: string;
  /** 引擎：首版恒 postgres（SQLite 演示通道走图内 sqlitePath，不建配置行） */
  engine: string;
  host: string;
  port: number;
  database: string;
  username: string;
  ssl: boolean;
  /** 已设置密码（回执不回传明文） */
  hasPassword: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DataSourceCreateParams {
  name: string;
  host: string;
  port?: number;
  database: string;
  username: string;
  password?: string;
  ssl?: boolean;
}

export interface DataSourceUpdateParams {
  id: number;
  name?: string;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  /** undefined = 不修改；null = 清空；非空串 = 更新 */
  password?: string | null;
  ssl?: boolean;
}

export interface DataSourceTestResult {
  success: boolean;
  /** 成功时的往返耗时 */
  latencyMs?: number;
  /** 失败原因（连接拒绝/超时/认证失败等原始信息，前端直显） */
  error?: string;
}

export class DataSourceApi {
  static async list(): Promise<DataSourceRecord[]> {
    return invoke<DataSourceRecord[]>("dataSource:list");
  }

  static async create(
    params: DataSourceCreateParams,
  ): Promise<DataSourceRecord> {
    return invoke<DataSourceRecord>("dataSource:create", params);
  }

  static async update(
    params: DataSourceUpdateParams,
  ): Promise<DataSourceRecord> {
    return invoke<DataSourceRecord>("dataSource:update", params);
  }

  static async delete(id: number): Promise<void> {
    return invoke<void>("dataSource:delete", id);
  }

  static async test(id: number): Promise<DataSourceTestResult> {
    return invoke<DataSourceTestResult>("dataSource:test", id);
  }
}

export default DataSourceApi;

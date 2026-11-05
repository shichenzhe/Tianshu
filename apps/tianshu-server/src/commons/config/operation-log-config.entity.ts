/**
 * 操作日志配置（config.yml `operationLog` 段，security.md §6 P0-2：
 * 遗留 #5 收口——脚手架 DISABLE_LOG 写死停用改为配置驱动，缺省启用）
 */
export class OperationLogConfig {
  /** 是否启用操作日志（false 时拦截器直通不落表；缺省 true） */
  enabled: boolean;

  static getDefault(): OperationLogConfig {
    const config = new OperationLogConfig();
    config.enabled = true;
    return config;
  }
}

/**
 * 解析启用态：段缺失/字段缺失均回落 true（缺省启用——启用是本批的
 * 语义本体，关闭需显式 false）；非布尔值（脏配置）同样回落缺省
 */
export function resolveOperationLogEnabled(
  raw: unknown,
): boolean {
  if (raw && typeof raw === 'object' && 'enabled' in raw) {
    const enabled = (raw as { enabled?: unknown }).enabled;
    return typeof enabled === 'boolean' ? enabled : true;
  }
  return true;
}

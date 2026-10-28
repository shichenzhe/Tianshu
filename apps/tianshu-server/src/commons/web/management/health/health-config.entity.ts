/**
 * 磁盘健康检查配置
 */
export interface DiskHealthConfig {
  enabled: boolean;
  thresholdPercent: number;
}

/**
 * 内存健康检查配置
 */
export interface MemoryHealthConfig {
  enabled: boolean;
  thresholdPercent: number;
}

/**
 * 健康检查配置
 */
export class HealthConfig {
  diskSpace: DiskHealthConfig;
  memory: MemoryHealthConfig;

  static getDefault(): HealthConfig {
    return {
      diskSpace: {
        enabled: true,
        thresholdPercent: 0.9,
      },
      memory: {
        enabled: true,
        thresholdPercent: 0.9,
      },
    };
  }
}

import { HealthConfig } from './health/health-config.entity';
import { MetricsConfig } from './metrics/metrics-config.entity';

/**
 * Management配置实体 - 参照SpringBoot Management配置结构
 */
export class ManagementConfig {
  /**
   * 健康检查配置
   */
  health?: HealthConfig;

  /**
   * 超时时间（毫秒）
   */
  timeout?: number;

  /**
   * 指标配置
   */
  metrics?: MetricsConfig;

  /**
   * 安全配置
   */
  security?: SecurityConfig;

  static getDefault(): ManagementConfig {
    return {
      health: {
        diskSpace: {
          enabled: true,
          thresholdPercent: 0.9,
        },
        memory: {
          enabled: true,
          thresholdPercent: 0.9,
        },
      },
      timeout: 5000,
      metrics: {
        enabled: true,
        enable: {
          system: true,
          http: true,
          process: true,
          datasource: true,
        },
        distribution: {
          'percentiles-histogram': {
            'http.server.requests': true,
          },
          percentiles: {
            'http.server.requests': '0.5,0.95,0.99',
          },
          slo: {
            'http.server.requests': '10ms,50ms,100ms,200ms,500ms,1s,2s,5s',
          },
        },
        tags: {
          application: 'demo',
          service: 'backend',
          version: '1.0.0',
          environment: 'development',
        },
        web: {
          server: {
            request: {
              autotime: {
                enabled: true,
                percentiles: '0.5,0.95,0.99',
                'percentiles-histogram': true,
              },
            },
          },
        },
      },
      security: {
        enabled: false,
        requireAuth: false,
        allowedIps: ['127.0.0.1', '::1'],
        tokens: [],
        users: [],
      },
    };
  }
}

/**
 * 安全配置
 */
export interface SecurityConfig {
  /**
   * 是否启用安全控制
   */
  enabled?: boolean;

  /**
   * 是否需要认证
   */
  requireAuth?: boolean;

  /**
   * 允许访问的IP地址列表（支持CIDR格式）
   */
  allowedIps?: string[];

  /**
   * 允许的Bearer tokens
   */
  tokens?: string[];

  /**
   * Basic认证用户列表
   */
  users?: SecurityUser[];
}

/**
 * 安全用户配置
 */
export interface SecurityUser {
  /**
   * 用户名
   */
  username: string;

  /**
   * 密码
   */
  password: string;
}

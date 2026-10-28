/**
 * 指标配置实体 - 参照SpringBoot Micrometer配置结构
 */
export class MetricsConfig {
  /**
   * 启用端点配置
   */
  enabled?: boolean;
  /**
   * 启用各类指标收集
   */
  enable?: MetricsEnableConfig;

  /**
   * 分布统计配置
   */
  distribution?: DistributionConfig;

  /**
   * 全局标签
   */
  tags?: Record<string, string>;

  /**
   * Web指标配置
   */
  web?: WebMetricsConfig;

  static getDefault(): MetricsConfig {
    return {
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
    };
  }
}

/**
 * 指标启用配置
 */
export interface MetricsEnableConfig {
  /**
   * 系统指标
   * @default true
   */
  system?: boolean;

  /**
   * HTTP指标
   * @default true
   */
  http?: boolean;

  /**
   * 进程指标
   * @default true
   */
  process?: boolean;

  /**
   * 连接池指标
   * @default true
   */
  datasource?: boolean;
}

/**
 * 分布统计配置
 */
export interface DistributionConfig {
  /**
   * 百分位直方图配置
   */
  'percentiles-histogram'?: Record<string, boolean>;

  /**
   * 百分位配置
   */
  percentiles?: Record<string, string>;

  /**
   * SLO配置
   */
  slo?: Record<string, string>;
}

/**
 * Web指标配置
 */
export interface WebMetricsConfig {
  server?: {
    request?: {
      autotime?: {
        /**
         * 是否启用自动计时
         * @default true
         */
        enabled?: boolean;

        /**
         * 百分位
         */
        percentiles?: string;

        /**
         * 是否启用百分位直方图
         * @default true
         */
        'percentiles-histogram'?: boolean;
      };
    };
  };
}

/**
 * 指标命名约定枚举
 */
export enum NamingConvention {
  /**
   * 蛇形命名法（推荐用于Prometheus）
   */
  SNAKE_CASE = 'snake_case',

  /**
   * 驼峰命名法
   */
  CAMEL_CASE = 'camelCase',

  /**
   * 点分隔命名法
   */
  DOT_NOTATION = 'dot.notation',
}

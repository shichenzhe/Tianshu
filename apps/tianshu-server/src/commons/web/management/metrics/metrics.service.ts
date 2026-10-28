import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as client from 'prom-client';
import { MetricsConfig, NamingConvention } from './metrics-config.entity';
import { Logger } from '../../../log/logger';
import { LoggerFactory } from '../../../log/logger-factory';
import { ManagementConfig } from '../management-config.entity';

/**
 * 指标类型枚举
 */
export enum MetricType {
  COUNTER = 'counter',
  GAUGE = 'gauge',
  HISTOGRAM = 'histogram',
  SUMMARY = 'summary',
}

/**
 * 指标创建选项
 */
export interface MetricOptions {
  name: string;
  help: string;
  labelNames?: string[];
  buckets?: number[]; // 用于Histogram
  percentiles?: number[]; // 用于Summary
  registers?: client.Registry[];
}

/**
 * 命名约定转换器
 */
class NamingConventionTransformer {
  /**
   * 转换指标名称
   */
  static transform(name: string, convention: NamingConvention): string {
    switch (convention) {
      case NamingConvention.SNAKE_CASE:
        return name
          .replace(/([A-Z])/g, '_$1')
          .toLowerCase()
          .replace(/^_/, '')
          .replace(/[.-]/g, '_');
      case NamingConvention.CAMEL_CASE:
        return name.replace(/[._-]([a-z])/g, (_, letter: string) =>
          letter.toUpperCase(),
        );
      case NamingConvention.DOT_NOTATION:
        return name.replace(/[_-]/g, '.');
      default:
        return name;
    }
  }

  /**
   * 转换标签名称
   */
  static transformLabel(label: string, convention: NamingConvention): string {
    switch (convention) {
      case NamingConvention.SNAKE_CASE:
        return label
          .replace(/([A-Z])/g, '_$1')
          .toLowerCase()
          .replace(/^_/, '')
          .replace(/[.-]/g, '_');
      default:
        return label;
    }
  }
}

/**
 * Metrics服务
 * 提供性能指标采集和管理功能，参照SpringBoot Micrometer实现
 */
@Injectable()
export class MetricsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger: Logger;
  private readonly managementConfig: ManagementConfig;
  private readonly metricsConfig: MetricsConfig;
  private readonly registry: client.Registry;
  private readonly namingConvention: NamingConvention;
  private defaultMetricsInterval?: NodeJS.Timeout;

  // 预定义的指标
  private readonly httpRequestsTotal: client.Counter<string>;
  private readonly httpRequestDuration: client.Histogram<string>;
  private readonly httpRequestDurationSummary?: client.Summary<string>;
  private readonly activeConnections: client.Gauge<string>;
  private readonly databaseConnections: client.Gauge<string>;
  private readonly customMetrics: Map<string, client.Metric<string>> =
    new Map();

  constructor(
    private readonly configService: ConfigService,
    private readonly loggerFactory: LoggerFactory,
  ) {
    this.logger = this.loggerFactory.create(MetricsService.name);

    // 获取management配置
    this.managementConfig = this.configService.get<ManagementConfig>(
      'management',
      ManagementConfig.getDefault(),
    );

    this.metricsConfig =
      this.managementConfig.metrics || MetricsConfig.getDefault();
    this.namingConvention = NamingConvention.SNAKE_CASE; // 默认使用snake_case

    // 创建注册表
    this.registry = new client.Registry();

    // 设置全局标签
    if (this.metricsConfig.tags) {
      const transformedTags: Record<string, string> = {};
      Object.entries(this.metricsConfig.tags).forEach(([key, value]) => {
        const transformedKey = NamingConventionTransformer.transformLabel(
          key,
          this.namingConvention,
        );
        transformedTags[transformedKey] = value;
      });
      this.registry.setDefaultLabels(transformedTags);
    }

    // 初始化预定义指标
    this.httpRequestsTotal = this.createCounter({
      name: 'http_server_requests_total',
      help: 'Total number of HTTP server requests',
      labelNames: ['method', 'uri', 'status', 'outcome'],
    });

    this.httpRequestDuration = this.createHistogram({
      name: 'http_server_requests_seconds',
      help: 'Duration of HTTP server request handling in seconds',
      labelNames: ['method', 'uri', 'status', 'outcome'],
      buckets: this.parseTimeBuckets(
        this.metricsConfig.distribution?.slo?.['http.server.requests'] ||
          '10ms,50ms,100ms,200ms,500ms,1s,2s,5s',
      ),
    });

    // 如果启用了percentiles-histogram，创建Summary指标
    if (
      this.metricsConfig.distribution?.['percentiles-histogram']?.[
        'http.server.requests'
      ]
    ) {
      const percentiles = this.parsePercentiles(
        this.metricsConfig.distribution?.percentiles?.[
          'http.server.requests'
        ] || '0.5,0.95,0.99',
      );

      this.httpRequestDurationSummary = this.createSummary({
        name: 'http_server_requests_seconds_summary',
        help: 'Duration of HTTP server request handling in seconds (percentiles)',
        labelNames: ['method', 'uri', 'status', 'outcome'],
        percentiles: percentiles,
      });
    }

    this.activeConnections = this.createGauge({
      name: 'http_server_connections_active',
      help: 'Number of currently active HTTP connections',
    });

    this.databaseConnections = this.createGauge({
      name: 'datasource_connections',
      help: 'datasource connection pool connections',
      labelNames: ['pool', 'state'],
    });
  }

  onModuleInit() {
    if (!this.isMetricsEnabled()) {
      this.logger.info('Metrics功能已禁用');
      return;
    }

    // 收集默认系统指标
    if (this.metricsConfig.enable?.system) {
      this.collectDefaultMetrics();
    }

    this.logger.info(
      `Metrics服务已启动，命名约定: ${this.namingConvention}，注册表: ${this.registry.getMetricsAsArray().length} 个指标`,
    );
  }

  onModuleDestroy() {
    if (this.defaultMetricsInterval) {
      clearInterval(this.defaultMetricsInterval);
    }
    this.registry.clear();
    this.logger.info('Metrics服务已销毁');
  }

  /**
   * 获取所有指标数据
   */
  async getMetrics(): Promise<string> {
    try {
      return await this.registry.metrics();
    } catch (error) {
      this.logger.error('获取指标数据失败', error);
      throw error;
    }
  }

  /**
   * 创建Counter指标
   */
  createCounter(options: MetricOptions): client.Counter<string> {
    const transformedName = this.transformMetricName(options.name);
    const transformedLabelNames = this.transformLabelNames(options.labelNames);

    const counter = new client.Counter({
      name: transformedName,
      help: options.help,
      labelNames: transformedLabelNames,
      registers: [this.registry],
    });

    this.customMetrics.set(transformedName, counter);
    this.logger.debug(`创建Counter指标: ${transformedName}`);
    return counter;
  }

  /**
   * 创建Gauge指标
   */
  createGauge(options: MetricOptions): client.Gauge<string> {
    const transformedName = this.transformMetricName(options.name);
    const transformedLabelNames = this.transformLabelNames(options.labelNames);

    const gauge = new client.Gauge({
      name: transformedName,
      help: options.help,
      labelNames: transformedLabelNames,
      registers: [this.registry],
    });

    this.customMetrics.set(transformedName, gauge);
    this.logger.debug(`创建Gauge指标: ${transformedName}`);
    return gauge;
  }

  /**
   * 创建Histogram指标
   */
  createHistogram(options: MetricOptions): client.Histogram<string> {
    const transformedName = this.transformMetricName(options.name);
    const transformedLabelNames = this.transformLabelNames(options.labelNames);

    const histogram = new client.Histogram({
      name: transformedName,
      help: options.help,
      labelNames: transformedLabelNames,
      buckets: options.buckets || client.exponentialBuckets(0.001, 2, 15),
      registers: [this.registry],
    });

    this.customMetrics.set(transformedName, histogram);
    this.logger.debug(`创建Histogram指标: ${transformedName}`);
    return histogram;
  }

  /**
   * 创建Summary指标
   */
  createSummary(options: MetricOptions): client.Summary<string> {
    const transformedName = this.transformMetricName(options.name);
    const transformedLabelNames = this.transformLabelNames(options.labelNames);

    const summary = new client.Summary({
      name: transformedName,
      help: options.help,
      labelNames: transformedLabelNames,
      percentiles: options.percentiles || [0.5, 0.9, 0.95, 0.99],
      registers: [this.registry],
    });

    this.customMetrics.set(transformedName, summary);
    this.logger.debug(`创建Summary指标: ${transformedName}`);
    return summary;
  }

  /**
   * 记录HTTP请求指标
   */
  recordHttpRequest(
    method: string,
    uri: string,
    statusCode: number,
    duration: number,
  ) {
    if (!this.isHttpMetricsEnabled()) {
      return;
    }

    const labels = {
      method: method.toUpperCase(),
      uri: this.normalizeUri(uri),
      status: statusCode.toString(),
      outcome: this.getOutcome(statusCode),
    };

    this.httpRequestsTotal.inc(labels);
    this.httpRequestDuration.observe(labels, duration / 1000); // 转换为秒

    // 如果启用了percentiles-histogram，同时记录Summary指标
    if (this.httpRequestDurationSummary) {
      this.httpRequestDurationSummary.observe(labels, duration / 1000);
    }
  }

  /**
   * 设置活跃连接数
   */
  setActiveConnections(count: number) {
    this.activeConnections.set(count);
  }

  /**
   * 设置数据库连接数
   */
  setDatabaseConnections(pool: string, state: string, count: number) {
    this.databaseConnections.set({ pool, state }, count);
  }

  /**
   * 获取指标
   */
  getMetric(name: string): client.Metric<string> | undefined {
    const transformedName = this.transformMetricName(name);
    return this.customMetrics.get(transformedName);
  }

  /**
   * 移除指标
   */
  removeMetric(name: string): boolean {
    const transformedName = this.transformMetricName(name);
    const metric = this.customMetrics.get(transformedName);
    if (metric) {
      this.registry.removeSingleMetric(transformedName);
      this.customMetrics.delete(transformedName);
      this.logger.debug(`移除指标: ${transformedName}`);
      return true;
    }
    return false;
  }

  /**
   * 获取配置信息
   */
  getConfig(): ManagementConfig {
    return { ...this.managementConfig };
  }

  /**
   * 重置所有指标
   */
  resetMetrics() {
    this.registry.resetMetrics();
    this.logger.info('所有指标已重置');
  }

  /**
   * 获取注册表
   */
  getRegistry(): client.Registry {
    return this.registry;
  }

  /**
   * 检查指标功能是否启用
   */
  public isMetricsEnabled(): boolean {
    return this.metricsConfig.enabled == true;
  }

  /**
   * 检查HTTP指标是否启用
   */
  public isHttpMetricsEnabled(): boolean {
    return this.isMetricsEnabled() && this.metricsConfig.enable?.http !== false;
  }

  /**
   * 收集默认系统指标
   */
  private collectDefaultMetrics() {
    // 收集Node.js默认指标
    client.collectDefaultMetrics({
      register: this.registry,
      prefix: '', // 不使用前缀，让命名约定处理
    });

    this.logger.debug('开始收集默认系统指标');
  }

  /**
   * 转换指标名称
   */
  private transformMetricName(name: string): string {
    return NamingConventionTransformer.transform(name, this.namingConvention);
  }

  /**
   * 转换标签名称
   */
  private transformLabelNames(labelNames?: string[]): string[] {
    if (!labelNames) return [];
    return labelNames.map((label) =>
      NamingConventionTransformer.transformLabel(label, this.namingConvention),
    );
  }

  /**
   * 规范化URI
   */
  private normalizeUri(uri: string): string {
    // 移除查询参数
    const withoutQuery = uri.split('?')[0];
    // 替换路径参数为占位符
    return withoutQuery.replace(/\/\d+/g, '/{id}');
  }

  /**
   * 获取请求结果
   */
  private getOutcome(statusCode: number): string {
    if (statusCode >= 200 && statusCode < 300) return 'SUCCESS';
    if (statusCode >= 300 && statusCode < 400) return 'REDIRECTION';
    if (statusCode >= 400 && statusCode < 500) return 'CLIENT_ERROR';
    if (statusCode >= 500) return 'SERVER_ERROR';
    return 'UNKNOWN';
  }

  /**
   * 解析时间桶配置
   */
  private parseTimeBuckets(sloConfig: string): number[] {
    return sloConfig.split(',').map((bucket) => {
      const trimmed = bucket.trim();
      if (trimmed.endsWith('ms')) {
        return parseFloat(trimmed.slice(0, -2)) / 1000;
      }
      if (trimmed.endsWith('s')) {
        return parseFloat(trimmed.slice(0, -1));
      }
      return parseFloat(trimmed);
    });
  }

  /**
   * 解析百分位数配置
   */
  private parsePercentiles(percentilesConfig: string): number[] {
    return percentilesConfig.split(',').map((percentile) => {
      return parseFloat(percentile.trim());
    });
  }
}

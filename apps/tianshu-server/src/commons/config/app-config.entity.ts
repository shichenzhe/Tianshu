/**
 * 应用配置
 */
export class AppConfig {
  // 服务名称
  name: string;
  // 服务端口号
  port: number;
  // 监听地址（缺省 0.0.0.0 监听所有网卡；内网部署建议指定，见 listen-host 告警）
  hostname?: string;
  // 反代终止 TLS 声明（P2-1）：非 loopback 明文监听启动告警的豁免标识——
  // 部署面由反代（nginx 等）终止 TLS 时置 true；env TIANSHU_TLS_PROXY=1 同效
  tlsBehindProxy?: boolean;
  // 服务根路径，没有默认为"/"
  contextPath: string;
  // 响应压缩配置
  compression?: CompressionConfig;

  static getDefault(): AppConfig {
    const defaultConfig = new AppConfig();
    defaultConfig.name = 'nestjs-app';
    defaultConfig.port = 3000;
    defaultConfig.contextPath = '/';
    defaultConfig.compression = CompressionConfig.getDefault();
    return defaultConfig;
  }
}

/**
 * 响应压缩配置
 */
export class CompressionConfig {
  /**
   * 是否启用压缩
   */
  enabled: boolean;
  // 只有响应体大于此值时才压缩（默认1KB）
  threshold: number;
  // 压缩级别 0-9，默认6
  level: number;
  // 内存级别 1-9，默认8
  memLevel: number;

  static getDefault(): CompressionConfig {
    return {
      enabled: true,
      threshold: 2048,
      level: 1,
      memLevel: 8,
    };
  }
}

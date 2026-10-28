/**
 * 响应配置
 */
export class ResponseConfig {
  // 不需要统一响应包装的接口路径列表
  excludePaths: string[];

  static getDefault(): ResponseConfig {
    const defaultConfig = new ResponseConfig();
    defaultConfig.excludePaths = ['/actuator/health'];
    return defaultConfig;
  }
}

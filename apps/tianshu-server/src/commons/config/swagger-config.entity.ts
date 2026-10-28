/**
 * Swagger配置
 */
export class SwaggerConfig {
  // 是否启用Swagger
  enabled: boolean;
  // Swagger访问路径
  path: string;
  // API标题
  title: string;
  // API描述
  description: string;
  // API版本
  version: string;

  static getDefault(): SwaggerConfig {
    const defaultConfig = new SwaggerConfig();
    defaultConfig.enabled = false;
    defaultConfig.path = '/api-docs';
    defaultConfig.title = 'API Documentation';
    defaultConfig.description = 'API Documentation';
    defaultConfig.version = '1.0.0';
    return defaultConfig;
  }
}

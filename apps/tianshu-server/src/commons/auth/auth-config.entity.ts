/**
 * Basic认证用户配置
 */
export interface BasicAuthUser {
  username: string;
  password: string;
  roles?: string[];
}

/**
 * JWT配置接口
 */
export interface JwtConfig {
  secret: string;
  expiresIn: string;
  refreshExpiresIn: string;
}

/**
 * Basic认证配置接口
 */
export interface BasicAuthConfig {
  users: BasicAuthUser[];
}

/**
 * 认证策略类型
 */
export type AuthStrategy = 'jwt' | 'basic';

/**
 * 认证配置接口
 */
export interface AuthConfig {
  global: boolean;
  defaultStrategy: AuthStrategy;
  jwt: JwtConfig;
  basic: BasicAuthConfig;
}

/**
 * 认证配置实体类
 */
export default class AuthConfigEntity implements AuthConfig {
  // 是否全局模块
  global: boolean;
  // 默认认证策略
  defaultStrategy: AuthStrategy;
  // JWT配置
  jwt: JwtConfig;
  // Basic Auth配置
  basic: BasicAuthConfig;

  constructor(config?: Partial<AuthConfig>) {
    this.global = config?.global ?? true;
    this.defaultStrategy = config?.defaultStrategy ?? 'jwt';
    this.jwt = config?.jwt as JwtConfig;
    this.basic = config?.basic as BasicAuthConfig;
  }

  /**
   * 获取默认配置实例
   */
  static getDefault(): AuthConfigEntity {
    return new AuthConfigEntity();
  }

  /**
   * 创建配置实例
   */
  static create(config?: Partial<AuthConfig>): AuthConfigEntity {
    return new AuthConfigEntity(config);
  }
}

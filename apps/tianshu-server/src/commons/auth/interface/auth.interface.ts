/**
 * 认证用户接口
 * 定义认证后的用户基本信息结构
 */
export interface IAuthUser {
  /** 用户名 */
  username: string;
  /** 角色列表 */
  roles?: string[];
}

/**
 * JWT载荷接口
 */
export interface IJwtPayload {
  /** 用户ID */
  sub: string;
  /** 用户名 */
  username: string;
  /**用户名称 */
  name: string;
  /** 角色列表 */
  roles?: string[];
  /** 签发时间 */
  iat?: number;
  /** 过期时间 */
  exp?: number;
  /** 扩展属性 */
  [key: string]: any;
}

/**
 * 认证配置接口
 */
export interface IAuthConfig {
  /** 默认认证策略 */
  defaultStrategy: 'jwt' | 'basic';
  /** 是否全局模块 */
  global?: boolean;
  /** JWT配置 */
  jwt?: {
    secret: string;
    expiresIn: string;
    refreshExpiresIn: string;
  };
  /** Basic Auth配置 */
  basic?: {
    users: Array<{
      username: string;
      password: string;
      roles?: string[];
    }>;
  };
}

// 定义访问上下文接口

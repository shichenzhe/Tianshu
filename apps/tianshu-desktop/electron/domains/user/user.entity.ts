/**
 * 用户实体类
 * 用于前后端共享的用户数据结构
 */

/**
 * 用户基本信息接口
 */
export interface UserBase {
  /**
   * 用户名
   */
  username: string;

  /**
   * 昵称
   */
  nickname?: string;

  /**
   * 邮箱
   */
  email?: string;
}

/**
 * 用户详细信息接口
 */
export interface UserInfo extends UserBase {
  /**
   * 用户ID
   */
  id: number;
}

/**
 * 用户认证信息接口
 */
export interface UserAuth extends UserInfo {
  /**
   * 认证令牌
   */
  token: string;
}

/**
 * 用户创建参数接口
 */
export interface UserCreateParams extends UserBase {
  /**
   * 密码
   */
  password: string;
}

/**
 * 用户修改参数接口
 */
export interface UserUpdateParams extends UserBase {
  /**
   * 用户ID
   */
  id: number;
}

/**
 * 用户登录参数接口
 */
export interface UserLoginParams {
  /**
   * 用户名
   */
  username: string;

  /**
   * 密码
   */
  password: string;
}

/**
 * 密码修改参数接口
 */
export interface PasswordUpdateParams {
  /**
   * 用户名
   */
  username: string;

  /**
   * 旧密码
   */
  oldPassword: string;
  /**
   * 新密码
   */
  newPassword: string;
}

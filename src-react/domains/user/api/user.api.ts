/**
 * 用户 API
 * 封装与主进程的 IPC 通信
 */

import { invoke } from "@/lib/ipc";
import type { UserBase, UserAuth } from "../store/user.store";

/**
 * 用户创建参数
 */
export interface UserCreateParams {
  username: string;
  nickname?: string;
  password: string;
  email: string;
}

/**
 * 用户登录参数
 */
export interface UserLoginParams {
  username: string;
  password: string;
}

/**
 * 用户更新参数
 */
export interface UserUpdateParams {
  id: number;
  username: string;
  nickname?: string;
  email?: string;
}

/**
 * 密码修改参数
 */
export interface PasswordUpdateParams {
  username: string;
  oldPassword: string;
  newPassword: string;
}

/**
 * 用户 API 类
 */
export class UserApi {
  /**
   * 根据用户名获取用户信息
   */
  static async getByUsername(username: string): Promise<UserBase> {
    return invoke<UserBase>("user:getByUsername", username);
  }

  /**
   * 创建用户
   * @returns 创建结果，-1 表示用户名或邮箱已存在
   */
  static async create(params: UserCreateParams): Promise<number> {
    return invoke<number>("user:create", params);
  }

  /**
   * 修改用户信息
   */
  static async modify(params: UserUpdateParams): Promise<number> {
    return invoke<number>("user:modify", params);
  }

  /**
   * 用户登录
   */
  static async login(params: UserLoginParams): Promise<UserAuth | null> {
    return invoke<UserAuth | null>("user:login", params);
  }

  /**
   * 验证 JWT token
   */
  static async verifyToken(token: string): Promise<unknown> {
    return invoke<unknown>("user:verifyToken", token);
  }

  /**
   * 修改密码
   */
  static async modifyPassword(params: PasswordUpdateParams): Promise<boolean> {
    return invoke<boolean>("user:modifyPassword", params);
  }

  /**
   * 创建 API Token
   */
  static async createApiToken(username: string): Promise<string> {
    return invoke<string>("user:createApiToken", username);
  }
}

export default UserApi;

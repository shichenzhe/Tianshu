/**
 * 用户数据库服务
 * 处理用户相关的数据库操作
 */
import { ipcMain } from "electron";
import * as jwt from "jsonwebtoken";
import prisma from "../../commons/prisma-client";
import {
  UserInfo,
  UserCreateParams,
  UserUpdateParams,
  UserAuth,
  UserLoginParams,
  PasswordUpdateParams,
} from "./user.entity";

export default class UserRepository {
  private JWT_SECRET = "3k4jl234jl2kj23423j"; // 建议使用环境变量存储

  constructor() {
    this.registerHandlers();
  }

  /**
   * 注册IPC处理程序
   */
  private registerHandlers() {
    ipcMain.handle("user:getByUsername", async (_, username: string) => {
      return this.getByUsername(username);
    });

    ipcMain.handle("user:modify", async (_, params: UserUpdateParams) => {
      return this.modify(params);
    });

    ipcMain.handle("user:create", async (_, params: UserCreateParams) => {
      return this.create(params);
    });

    ipcMain.handle("user:login", async (_, params: UserLoginParams) => {
      return this.login(params);
    });

    ipcMain.handle("user:verifyToken", async (_, token: string) => {
      return this.verifyToken(token);
    });

    ipcMain.handle(
      "user:modifyPassword",
      async (_, params: PasswordUpdateParams) => {
        return this.modifyPassword(params);
      },
    );

    ipcMain.handle("user:createApiToken", async (_, username: string) => {
      return this.createApiToken(username);
    });
  }

  /**
   * 根据用户名获取用户信息
   * @param username 用户名
   * @returns 用户数据
   */
  async getByUsername(username: string): Promise<UserInfo> {
    const result = await prisma.user.findFirst({
      where: {
        username: username,
      },
      select: {
        id: true,
        username: true,
        nickname: true,
        email: true,
      },
    });
    console.info("user", result);
    return result;
  }

  /**
   * 获取用户Id
   * @returns id
   */
  async getUserId(username: string): Promise<number | null> {
    const user = await prisma.user.findFirst({
      where: {
        username: username,
      },
      select: {
        id: true,
      },
    });
    return !user ? null : user.id;
  }

  /**
   * 根据用户名获取用户信息
   * @param username 用户名
   * @param email 邮箱
   * @returns 用户数据
   */
  async getIdByUsernameOrEmail(
    username: string,
    email: string,
  ): Promise<number | null> {
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          {
            username: username,
          },
          {
            email: email,
          },
        ],
      },
      select: {
        id: true,
      },
    });
    return !user ? null : user.id;
  }

  /**
   * 创建用户
   * @param params 用户创建参数
   */
  async create(params: UserCreateParams): Promise<number> {
    const id = await this.getIdByUsernameOrEmail(
      params.username,
      params.email || "",
    );
    if (id !== null) {
      return -1;
    }

    const newUser = await prisma.user.create({
      data: {
        username: params.username,
        nickname: params.nickname,
        password: params.password,
        email: params.email,
      },
    });

    console.info("用户创建成功：", newUser);

    return 1;
  }

  /**
   * 修改用户信息
   * @param params 用户更新参数
   */
  async modify(params: UserUpdateParams): Promise<number> {
    const existId = await this.getIdByUsernameOrEmail(
      params.username,
      params.email || "",
    );
    console.info("modifyUsser:" + params.id, existId);
    if (existId !== null && existId != params.id) {
      return -1;
    }

    const updateUser = await prisma.user.update({
      where: {
        id: params.id,
      },
      data: {
        username: params.username,
        nickname: params.nickname,
        email: params.email,
      },
    });
    console.info("modify", updateUser);
    return 1;
  }

  /**
   * 验证密码
   * @param params 用户登录参数
   * @returns 验证结果
   */
  async login(params: UserLoginParams): Promise<UserAuth> {
    const user: UserInfo = await prisma.user.findFirst({
      where: {
        username: params.username,
        password: params.password,
      },
      select: {
        id: true,
        username: true,
        nickname: true,
        email: true,
      },
    });

    if (!user) {
      throw new Error("用户名或密码错误");
    }
    // 生成JWT token
    const token = this.generateToken(user);
    console.info("login sucess:", token);
    return { ...user, token };
  }

  /**
   * 生成JWT token
   * @param user 用户信息
   * @returns JWT token
   */
  private generateToken(user: UserInfo): string {
    const options: jwt.SignOptions = {
      expiresIn: "30d",
    };
    return jwt.sign(
      { username: user.username, nickname: user.nickname },
      this.JWT_SECRET,
      options,
    );
  }

  /**
   * 验证JWT token
   * @param token JWT token
   * @returns 解码后的用户信息或null
   */
  async verifyToken(token: string): Promise<unknown> {
    try {
      return jwt.verify(token, this.JWT_SECRET);
    } catch (error) {
      console.error("Token验证失败:", error);
      return null;
    }
  }

  /**
   * 修改密码
   * @param username 用户名
   * @param password 新密码
   */
  async modifyPassword(params: PasswordUpdateParams): Promise<boolean> {
    const user = await prisma.user.findFirst({
      where: {
        username: params.username,
        password: params.oldPassword,
      },
    });
    if (!user) {
      return false;
    }

    await prisma.user.update({
      where: {
        id: user.id, // 使用唯一主键更新更安全
      },
      data: {
        password: params.newPassword,
      },
    });
    return true;
  }

  /**
   * 创建api token
   * @param username 用户名
   * @returns api token
   *
   *
   */
  async createApiToken(username: string): Promise<string> {
    const result = await prisma.user.findFirst({
      where: {
        username: username,
      },
      select: {
        password: true,
      },
    });
    if (!result) {
      throw new Error("用户不存在" + username);
    }
    const basicAuth = Buffer.from(`${username}:${result.password}`).toString(
      "base64",
    );
    console.info("createApiToken:", basicAuth);
    return basicAuth;
  }
}

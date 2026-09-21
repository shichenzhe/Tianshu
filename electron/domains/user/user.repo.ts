/**
 * 用户数据库服务
 * 处理用户相关的数据库操作
 */
import { ipcMain } from "electron";
import * as jwt from "jsonwebtoken";
import {
  generateUserToken,
  getJwtSecret,
  handleUser,
} from "../../commons/ipc-user";
import prisma from "../../commons/prisma-client";
import { hashPassword, isHashedPassword, verifyPassword } from "./password";
import {
  UserInfo,
  UserCreateParams,
  UserUpdateParams,
  UserAuth,
  UserLoginParams,
  PasswordUpdateParams,
} from "./user.entity";

export default class UserRepository {
  constructor() {
    this.registerHandlers();
  }

  /**
   * 注册IPC处理程序
   */
  private registerHandlers() {
    // handleUser：资料类操作需登录（login/create/verifyToken 保留匿名——登录前无 token）
    handleUser("user:getByUsername", (_, _userId, username: string) => {
      return this.getByUsername(username);
    });

    handleUser("user:modify", (_, _userId, params: UserUpdateParams) => {
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

    handleUser(
      "user:modifyPassword",
      (_, _userId, params: PasswordUpdateParams) => {
        return this.modifyPassword(params);
      },
    );
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
    return this.toUserInfo(result!);
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
        password: hashPassword(params.password),
        email: params.email,
      },
    });

    console.info("用户创建成功：", newUser.username);

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
    if (existId !== null && existId != params.id) {
      return -1;
    }

    await prisma.user.update({
      where: {
        id: params.id,
      },
      data: {
        username: params.username,
        nickname: params.nickname,
        email: params.email,
      },
    });
    return 1;
  }

  /**
   * 验证密码
   * @param params 用户登录参数
   * @returns 验证结果
   */
  async login(params: UserLoginParams): Promise<UserAuth> {
    const user = await prisma.user.findFirst({
      where: {
        username: params.username,
      },
      select: {
        id: true,
        username: true,
        nickname: true,
        email: true,
        password: true,
      },
    });

    if (!user || !verifyPassword(params.password, user.password)) {
      throw new Error("用户名或密码错误");
    }
    // 存量明文密码平滑迁移：校验通过后原地升级为 scrypt 哈希
    // （迁移失败不阻断登录，下次登录再试）
    if (!isHashedPassword(user.password)) {
      await prisma.user
        .update({
          where: { id: user.id },
          data: { password: hashPassword(params.password) },
        })
        .catch((e) => console.error("密码哈希迁移失败:", e));
    }
    const userInfo = this.toUserInfo(user); // 多余的 password 列由结构类型自然丢弃
    return { ...userInfo, token: this.generateToken(userInfo) };
  }

  /**
   * Prisma 行转 UserInfo 契约（null→undefined）
   * @param row Prisma 查询行
   * @returns 用户信息
   */
  private toUserInfo(row: {
    id: number;
    username: string;
    nickname: string | null;
    email: string | null;
  }): UserInfo {
    return {
      id: row.id,
      username: row.username,
      nickname: row.nickname ?? undefined,
      email: row.email ?? undefined,
    };
  }

  /**
   * 生成JWT token
   * @param user 用户信息
   * @returns JWT token
   */
  private generateToken(user: UserInfo): string {
    // v12 多用户隔离：payload 补签 id，业务 IPC 由 commons/ipc-user 解出 userId
    return generateUserToken(user);
  }

  /**
   * 验证JWT token
   * @param token JWT token
   * @returns 解码后的用户信息或null
   */
  async verifyToken(token: string): Promise<unknown> {
    try {
      return jwt.verify(token, getJwtSecret());
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
      },
      select: {
        id: true,
        password: true,
      },
    });
    if (!user || !verifyPassword(params.oldPassword, user.password)) {
      return false;
    }

    await prisma.user.update({
      where: {
        id: user.id, // 使用唯一主键更新更安全
      },
      data: {
        password: hashPassword(params.newPassword),
      },
    });
    return true;
  }
}

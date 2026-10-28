/**
 * 选项数据库服务
 * 处理选项相关的数据库操作
 */
import { handleUser } from "../../commons/ipc-user";
import prisma from "../../commons/prisma-client";
import { APP_OPTION_TYPE } from "../app-settings/option-store";
import {
  OptionItem,
  OptionCreateParams,
  OptionDeleteParams,
  OptionUpdateParams,
} from "./option.entity";

export default class OptionRepository {
  constructor() {
    this.registerHandlers();
  }

  /**
   * 注册IPC处理程序（userId 由 token 解出，见 commons/ipc-user）
   */
  private registerHandlers() {
    handleUser("option:listByType", (_, userId, type: string) => {
      return this.listByType(type, userId);
    });

    // 注册新增选项的处理程序
    handleUser("option:create", (_, userId, params: OptionCreateParams) => {
      return this.create(params, userId);
    });

    // 注册删除选项的处理程序
    handleUser("option:delete", (_, userId, params: OptionDeleteParams) => {
      return this.delete(params, userId);
    });

    // 注册更新选项的处理程序
    handleUser("option:update", (_, userId, params: OptionUpdateParams) => {
      return this.update(params, userId);
    });
  }

  /**
   * 选项归属列取值：应用级 type（如 proxy/keepAwake）恒 NULL = 全局共享，
   * 其余类型归当前用户
   * @param type 选项类型
   * @param userId 当前用户 id
   */
  private ownerOf(type: string, userId: number): number | null {
    return type === APP_OPTION_TYPE ? null : userId;
  }

  /**
   * 根据类型查询选项数据
   * @param type 选项类型
   * @param userId 当前用户 id
   * @returns 选项数据数组
   */
  async listByType(type: string, userId: number): Promise<OptionItem[]> {
    const options = await prisma.option.findMany({
      where: {
        type: type,
        userId: this.ownerOf(type, userId),
      },
      select: {
        value: true,
        name: true,
        note: true,
      },
      orderBy: {
        name: "asc",
      },
    });

    return options.map((option) => ({
      value: option.value,
      name: option.name,
      note: option.note ?? undefined,
    }));
  }

  /**
   * 新增选项
   * @param params 创建参数
   * @param userId 当前用户 id
   * @returns 新增的选项ID
   */
  async create(params: OptionCreateParams, userId: number): Promise<number> {
    try {
      const result = await prisma.option.create({
        data: { ...params, userId: this.ownerOf(params.type, userId) },
      });

      return result.id;
    } catch (error) {
      console.error("添加选项失败:", error);
      throw error;
    }
  }

  /**
   * 更新选项
   * @param params 更新参数
   * @param userId 当前用户 id
   * @returns 是否更新成功
   */
  async update(params: OptionUpdateParams, userId: number): Promise<boolean> {
    try {
      const result = await prisma.option.updateMany({
        where: {
          type: params.type,
          name: params.name,
          userId: this.ownerOf(params.type, userId),
        },
        data: {
          value: params.value,
          note: params.note,
        },
      });

      return result.count > 0;
    } catch (error) {
      console.error("更新选项失败:", error);
      throw error;
    }
  }

  /**
   * 删除选项
   * @param params 删除参数
   * @param userId 当前用户 id
   * @returns 是否删除成功
   */
  async delete(params: OptionDeleteParams, userId: number): Promise<boolean> {
    try {
      const result = await prisma.option.deleteMany({
        where: {
          type: params.type,
          name: params.name,
          userId: this.ownerOf(params.type, userId),
        },
      });

      return result.count > 0;
    } catch (error) {
      console.error("删除选项失败:", error);
      throw error;
    }
  }
}

/**
 * 选项数据库服务
 * 处理选项相关的数据库操作
 */
import { ipcMain } from "electron";
import prisma from "../../commons/prisma-client";
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
   * 注册IPC处理程序
   */
  private registerHandlers() {
    ipcMain.handle("option:listByType", async (_, type: string) => {
      return this.listByType(type);
    });

    // 注册新增选项的处理程序
    ipcMain.handle("option:create", async (_, params: OptionCreateParams) => {
      return this.create(params);
    });

    // 注册删除选项的处理程序
    ipcMain.handle("option:delete", async (_, params: OptionDeleteParams) => {
      return this.delete(params);
    });

    // 注册更新选项的处理程序
    ipcMain.handle("option:update", async (_, params: OptionUpdateParams) => {
      return this.update(params);
    });
  }

  /**
   * 根据类型查询选项数据
   * @param type 选项类型
   * @returns 选项数据数组
   */
  async listByType(type: string): Promise<OptionItem[]> {
    const options = await prisma.option.findMany({
      where: {
        type: type,
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
   * @returns 新增的选项ID
   */
  async create(params: OptionCreateParams): Promise<number> {
    try {
      const result = await prisma.option.create({
        data: params,
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
   * @returns 是否更新成功
   */
  async update(params: OptionUpdateParams): Promise<boolean> {
    try {
      const result = await prisma.option.updateMany({
        where: {
          type: params.type,
          name: params.name,
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
   * @returns 是否删除成功
   */
  async delete(params: OptionDeleteParams): Promise<boolean> {
    try {
      const result = await prisma.option.deleteMany({
        where: {
          type: params.type,
          name: params.name,
        },
      });

      return result.count > 0;
    } catch (error) {
      console.error("删除选项失败:", error);
      throw error;
    }
  }
}

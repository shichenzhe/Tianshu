import { ipcMain } from "electron";
import OpenAI from "openai";
import prisma from "../../commons/prisma-client";
import type {
  ModelConfigCreateParams,
  ModelConfigRecord,
  ModelConfigUpdateParams,
} from "../../../src-react/domains/ai/api/model-config.api";

export class ModelConfigRepository {
  constructor() {
    this.registerIpcHandlers();
  }

  private registerIpcHandlers() {
    ipcMain.handle("modelConfig:list", () => this.list());
    ipcMain.handle("modelConfig:getById", (_, id: number) => this.getById(id));
    ipcMain.handle("modelConfig:create", (_, params: ModelConfigCreateParams) =>
      this.create(params),
    );
    ipcMain.handle("modelConfig:update", (_, params: ModelConfigUpdateParams) =>
      this.update(params),
    );
    ipcMain.handle("modelConfig:delete", (_, id: number) => this.delete(id));
    ipcMain.handle("modelConfig:setActive", (_, id: number) =>
      this.setActive(id),
    );
    ipcMain.handle("modelConfig:test", (_, id: number) => this.test(id));
    ipcMain.handle("modelConfig:getActive", () => this.getActive());
  }

  /**
   * 获取模型配置列表
   */
  async list(): Promise<ModelConfigRecord[]> {
    try {
      const configs = await prisma.modelConfig.findMany({
        orderBy: [{ isActive: "desc" }, { createdAt: "desc" }],
      });
      return configs;
    } catch (error) {
      console.error("获取模型配置列表失败:", error);
      throw error;
    }
  }

  /**
   * 根据ID获取模型配置
   */
  async getById(id: number): Promise<ModelConfigRecord | null> {
    try {
      const config = await prisma.modelConfig.findUnique({
        where: { id },
      });
      return config;
    } catch (error) {
      console.error("获取模型配置失败:", error);
      throw error;
    }
  }

  /**
   * 创建模型配置
   */
  async create(params: ModelConfigCreateParams): Promise<ModelConfigRecord> {
    try {
      // 如果设置为激活，先将其他配置设为非激活
      if (params.isActive) {
        await prisma.modelConfig.updateMany({
          data: { isActive: false },
        });
      }

      const config = await prisma.modelConfig.create({
        data: {
          name: params.name,
          modelName: params.modelName,
          apiKey: params.apiKey,
          baseUrl: params.baseUrl,
          maxTokens: params.maxTokens,
          temperature: params.temperature,
          isActive: params.isActive || false,
        },
      });
      return config;
    } catch (error) {
      console.error("创建模型配置失败:", error);
      throw error;
    }
  }

  /**
   * 更新模型配置
   */
  async update(params: ModelConfigUpdateParams): Promise<ModelConfigRecord> {
    try {
      // 如果设置为激活，先将其他配置设为非激活
      if (params.isActive) {
        await prisma.modelConfig.updateMany({
          where: { id: { not: params.id } },
          data: { isActive: false },
        });
      }

      const config = await prisma.modelConfig.update({
        where: { id: params.id },
        data: {
          name: params.name,
          modelName: params.modelName,
          apiKey: params.apiKey,
          baseUrl: params.baseUrl,
          maxTokens: params.maxTokens,
          temperature: params.temperature,
          isActive: params.isActive,
        },
      });
      return config;
    } catch (error) {
      console.error("更新模型配置失败:", error);
      throw error;
    }
  }

  /**
   * 删除模型配置
   */
  async delete(id: number): Promise<void> {
    try {
      await prisma.modelConfig.delete({
        where: { id },
      });
    } catch (error) {
      console.error("删除模型配置失败:", error);
      throw error;
    }
  }

  /**
   * 设置激活状态
   */
  async setActive(id: number): Promise<void> {
    try {
      // 先将所有配置设为非激活
      await prisma.modelConfig.updateMany({
        data: { isActive: false },
      });

      // 设置指定配置为激活
      await prisma.modelConfig.update({
        where: { id },
        data: { isActive: true },
      });
    } catch (error) {
      console.error("设置激活状态失败:", error);
      throw error;
    }
  }

  /**
   * 获取激活的模型配置
   */
  async getActive(): Promise<ModelConfigRecord | null> {
    try {
      const config = await prisma.modelConfig.findFirst({
        where: { isActive: true },
      });
      return config;
    } catch (error) {
      console.error("获取激活模型配置失败:", error);
      throw error;
    }
  }

  /**
   * 测试模型配置（发送最小请求验证连通性）
   */
  async test(id: number): Promise<{ success: boolean; message: string }> {
    const config = await this.getById(id);
    if (!config) {
      return { success: false, message: "模型配置不存在" };
    }
    try {
      const openai = new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseUrl,
      });
      await openai.chat.completions.create({
        model: config.modelName,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 5,
      });
      return { success: true, message: "连接测试成功" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, message: `连接测试失败: ${message}` };
    }
  }
}

/**
 * 选项 API
 */

import { invoke } from "@/lib/ipc";
import type {
  OptionItem,
  OptionCreateParams,
  OptionDeleteParams,
  OptionUpdateParams,
  OptionQueryParams,
} from "../model/option";

export class OptionApi {
  /**
   * 查询选项数据
   */
  static async listByType(params: OptionQueryParams): Promise<OptionItem[]> {
    try {
      return await invoke<OptionItem[]>("option:listByType", params.type);
    } catch (error) {
      console.error("获取下拉选项失败:", error);
      throw error;
    }
  }

  /**
   * 新增选项数据
   */
  static async create(params: OptionCreateParams): Promise<void> {
    try {
      await invoke("option:create", params);
    } catch (error) {
      console.error("新增下拉选项失败:", error);
      throw error;
    }
  }

  /**
   * 删除选项数据
   */
  static async delete(params: OptionDeleteParams): Promise<void> {
    try {
      await invoke("option:delete", params);
    } catch (error) {
      console.error("删除下拉选项失败:", error);
      throw error;
    }
  }

  /**
   * 更新选项数据
   */
  static async update(params: OptionUpdateParams): Promise<void> {
    try {
      await invoke("option:update", params);
    } catch (error) {
      console.error("更新下拉选项失败:", error);
      throw error;
    }
  }
}

export default OptionApi;

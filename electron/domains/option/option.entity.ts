/**
 * 选项数据接口
 * 用于前后端共享的选项数据结构
 */
export interface OptionItem {
  /**
   * 选项值
   */
  value: string;

  /**
   * 选项标题/名称
   */
  name: string;

  /**
   * 选项备注
   */
  note?: string;
}

/**
 * 选项创建参数
 */
export interface OptionCreateParams {
  /**
   * 选项类型
   */
  type: string;

  /**
   * 选项值
   */
  value: string;

  /**
   * 选项标题/名称
   */
  name: string;

  /**
   * 选项备注
   */
  note?: string;
}

/**
 * 选项查询参数
 */
export interface OptionQueryParams {
  /**
   * 选项类型
   */
  type: string;
}

/**
 * 选项删除参数
 */
export interface OptionDeleteParams {
  /**
   * 选项类型
   */
  type: string;

  /**
   * 选项名
   */
  name: string;
}

/**
 * 选项更新参数
 */
export interface OptionUpdateParams {
  /**
   * 选项类型
   */
  type: string;

  /**
   * 选项名称（用于查找）
   */
  name: string;

  /**
   * 选项值（要更新的值）
   */
  value: string;

  /**
   * 选项备注（要更新的备注）
   */
  note?: string;
}

import { QueryFilter } from './query-filter';

/**
 * 声明查询条件解析接口。
 */
export interface QueryDecoder {
  /**
   * 构造查询条件。
   * @param params
   */
  condition(params: QueryFilter): any;

  /**
   *
   * 构造排序条件。
   * @param params
   */
  sort(params: QueryFilter): any;
}

import { QueryFilter } from 'src/commons/query/query-filter';
import { JsonDateTime } from 'src/commons/codec/JsonDateTime.decorator';

/**
 * 操作日志查询过滤器
 */
export class OperationLogQueryFilter extends QueryFilter {
  /** 用户ID */
  userId?: string;

  /** 操作类型 */
  operation?: string;

  /** 操作状态 */
  status?: string;

  /** IP地址 */
  ipAddress?: string;

  /** 开始时间 */
  @JsonDateTime()
  startDate?: Date;

  /** 结束时间 */
  @JsonDateTime()
  endDate?: Date;

  /** 最小执行时间(毫秒) */
  minExecutionTime?: number;

  /** 最大执行时间(毫秒) */
  maxExecutionTime?: number;
}

/**
 * 操作日志实体
 */
export class OperationLog {
  /** 用户ID */
  userId: string;

  /** 操作类型 */
  operation: string;

  /** 操作详情 */
  details?: any;

  /** IP地址 */
  ipAddress?: string | null;

  /** 用户代理 */
  userAgent?: string | null;

  /** 执行时间(毫秒) */
  executionTime?: number;

  /** 创建时间 */
  createdAt: Date;

  /** 操作状态 */
  status: string;

  constructor(partial: Partial<any>) {
    Object.assign(this, partial);
  }
}

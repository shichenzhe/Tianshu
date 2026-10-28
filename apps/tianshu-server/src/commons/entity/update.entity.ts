import { OperateContext } from './operate-context.entity';

/**
 * 更新实体基类
 */
export class UpdateEntity {
  /** 更新时间 */
  updatedAt: Date;
  /**最后修改人代码 */
  updatorId: string;
  /**最后修改人名称 */
  updatorName: string;

  constructor(partial: Partial<UpdateEntity>) {
    Object.assign(this, partial);
  }
  /**
   * 更新时调用
   * @param operateContext 操作上下文
   */
  onUpdated(operateContext: OperateContext) {
    this.updatedAt = operateContext.time;
    this.updatorId = operateContext.operator.code;
    this.updatorName = operateContext.operator.name;
  }
}

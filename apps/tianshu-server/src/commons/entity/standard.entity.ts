import { Entity } from './entity';
import { OperateContext } from './operate-context.entity';

/**
 * 标准实体对象
 */
export class StandardEntity extends Entity {
  /** 创建时间 */
  createdAt: Date;
  /**创建人代码 */
  creatorId: string;
  /**创建人名称*/
  creatorName: string;

  /** 更新时间 */
  updatedAt: Date;
  /**最后修改人代码 */
  updatorId: string;
  /**最后修改人名称 */
  updatorName: string;

  constructor(partial: Partial<any>) {
    super(partial);
    Object.assign(this, partial);
  }

  /**
   * 创建时调用
   * @param operateContext 操作上下文
   */
  onCreated(operateContext: OperateContext) {
    this.createdAt = operateContext.time;
    this.creatorId = operateContext.operator.code;
    this.creatorName = operateContext.operator.name;
    this.updatedAt = operateContext.time;
    this.updatorId = operateContext.operator.code;
    this.updatorName = operateContext.operator.name;
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

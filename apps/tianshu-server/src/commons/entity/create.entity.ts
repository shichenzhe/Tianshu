import { Entity } from './entity';
import { OperateContext } from './operate-context.entity';

/**
 * 更新实体基类
 */
export class CreateEntity extends Entity {
  /** 创建时间 */
  createdAt: Date;
  /**创建人代码 */
  creatorId: string;
  /**创建人名称 */
  creatorName: string;

  constructor(partial: Partial<CreateEntity>) {
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
  }
}

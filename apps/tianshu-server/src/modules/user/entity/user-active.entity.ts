import { UpdateEntity } from 'src/commons/entity/update.entity';

/**
 * 更新用户状态的参数
 */
export class UserActiveEntity extends UpdateEntity {
  isActive: boolean;

  constructor(partial: Partial<any>) {
    super(partial);
    Object.assign(this, partial);
  }
}

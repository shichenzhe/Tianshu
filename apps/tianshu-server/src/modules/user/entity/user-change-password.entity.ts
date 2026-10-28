import { UpdateEntity } from 'src/commons/entity/update.entity';

/**
 * 更新用户状态的参数
 */
export class UserChangePasswordEntity extends UpdateEntity {
  passwordHash: string;

  constructor(partial: Partial<any>) {
    super(partial);
    Object.assign(this, partial);
  }
}

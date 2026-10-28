import { UserType } from '@prisma/client';
import { StandardEntity } from 'src/commons/entity/standard.entity';

/**
 * 用户实体
 */
export class UserEntity extends StandardEntity {
  /** 用户名 */
  username: string;

  /** 密码哈希 */
  passwordHash: string;

  /** 真实姓名 */
  name: string;

  /** 手机号 */
  phone: string | null;

  /** 邮箱 */
  email: string | null;

  /** 用户类型 */
  userType: UserType;

  /** 是否激活 */
  isActive: boolean;

  /** 备注 */
  note: string | null;

  /** 最后登录时间 */
  lastLoginTime?: Date | null;

  constructor(partial: Partial<any>) {
    super(partial);
    Object.assign(this, partial);
  }

  /**
   * 获取用户角色列表
   */
  getRoles(): string[] {
    return [this.userType.toLowerCase()];
  }

  /**
   * 检查是否为管理员
   */
  isAdmin(): boolean {
    return this.userType === UserType.admin;
  }
}

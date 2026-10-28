import { UserType } from '@prisma/client';
import { Expose, plainToInstance } from 'class-transformer';
import { StandardEntity } from 'src/commons/entity/standard.entity';

/**
 * 用户实体
 */
export class UserCreateEntity extends StandardEntity {
  /** 用户名 */
  @Expose()
  username: string;

  /** 密码哈希 */
  @Expose()
  passwordHash: string;

  /** 真实姓名 */
  @Expose()
  name: string;

  /** 手机号 */
  @Expose()
  phone: string | null;

  /** 邮箱 */
  @Expose()
  email: string | null;

  /** 用户类型 */
  @Expose()
  userType: UserType;

  /** 是否激活 */
  @Expose()
  isActive: boolean;

  /** 备注 */
  @Expose()
  note: string | null;

  /** 最后登录时间 */
  @Expose()
  lastLoginTime?: Date | null;

  static create(partial: Partial<any>): UserCreateEntity {
    return plainToInstance(UserCreateEntity, partial, {
      excludeExtraneousValues: true,
    });
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

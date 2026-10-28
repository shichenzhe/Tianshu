import { Expose, plainToInstance } from 'class-transformer';
import { UpdateEntity } from 'src/commons/entity/update.entity';

/**
 * 更新用户的信息
 */
export class UserUpdateEntity extends UpdateEntity {
  @Expose()
  name?: string;
  @Expose()
  phone?: string;
  @Expose()
  email?: string;
  @Expose()
  isActive: boolean;
  @Expose()
  note: string;

  static create(partial: Partial<any>): UserUpdateEntity {
    return plainToInstance(UserUpdateEntity, partial, {
      excludeExtraneousValues: true,
    });
  }
}

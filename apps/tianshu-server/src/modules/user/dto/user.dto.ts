import { UserType } from '@prisma/client';
import { UserEntity } from '../entity/user.entity';
import { Expose, plainToInstance } from 'class-transformer';
/**
 * 用户响应DTO
 */
export class UserDto {
  @Expose()
  id: string;
  @Expose()
  username: string;
  @Expose()
  name: string;
  @Expose()
  phone: string | null;
  @Expose()
  email: string | null;
  @Expose()
  note: string | null;
  @Expose()
  userType: UserType;
  @Expose()
  isActive: boolean;
  @Expose()
  createdAt: Date;
  @Expose()
  updatedAt: Date;
  @Expose()
  lastLoginTime: Date | null;

  static create(partial: Partial<UserEntity>): UserDto {
    return plainToInstance(UserDto, partial, {
      excludeExtraneousValues: true,
    });
  }
}

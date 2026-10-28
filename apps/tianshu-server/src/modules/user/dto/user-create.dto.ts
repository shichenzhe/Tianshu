import { UserType } from '@prisma/client';
import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

/**
 * 创建用户DTO
 */
export class UserCreateDto {
  @IsNotEmpty({ message: '用户名不能为空' })
  @IsString({ message: '用户名必须是字符串' })
  username: string;

  @IsNotEmpty({ message: '密码不能为空' })
  @IsString({ message: '密码必须是字符串' })
  @MinLength(6, { message: '密码长度不能少于6位' })
  password: string;

  @IsNotEmpty({ message: '真实姓名不能为空' })
  @IsString({ message: '真实姓名必须是字符串' })
  name: string;

  @IsOptional()
  @IsString({ message: '手机号必须是字符串' })
  phone?: string | null;

  @IsOptional()
  @ValidateIf(
    (object: UserCreateDto) =>
      object.email !== undefined && object.email !== '',
  )
  @IsEmail({}, { message: '邮箱格式不正确' })
  email?: string;

  @IsNotEmpty({ message: '用户类型不能为空' })
  @IsEnum(UserType, { message: '用户类型不正确' })
  userType: UserType;

  @IsNotEmpty({ message: '用户状态不能为空' })
  isActive: boolean;

  @IsOptional()
  @MaxLength(255, { message: '备注长度不能超过255位' })
  note: string;
}

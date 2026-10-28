import { Expose, plainToInstance } from 'class-transformer';
import { IsNotEmpty, IsString, MinLength } from 'class-validator';

/**
 * 登录请求DTO
 */
export class LoginDto {
  @IsNotEmpty({ message: '用户名不能为空' })
  @IsString({ message: '用户名必须是字符串' })
  username: string;

  @IsNotEmpty({ message: '密码不能为空' })
  @IsString({ message: '密码必须是字符串' })
  @MinLength(6, { message: '密码长度不能少于6位' })
  password: string;
}

/**
 * 登录响应DTO
 */
export class LoginResponseDto {
  /** 访问令牌 */
  @Expose()
  accessToken: string;

  /** 刷新令牌 */
  @Expose()
  refreshToken: string;

  /** 用户信息 */
  @Expose()
  user: {
    id: string;
    username: string;
    name: string;
    userType: string;
    phone: string | null;
    email: string | null;
    note: string | null;
  };

  static create(partial: Partial<any>): LoginResponseDto {
    return plainToInstance(LoginResponseDto, partial, {
      excludeExtraneousValues: true,
    });
  }
}

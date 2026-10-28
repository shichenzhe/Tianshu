import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * 修改密码DTO
 */
export class UserChangePasswordDto {
  @IsNotEmpty({ message: '原密码不能为空' })
  @IsString({ message: '原密码必须是字符串' })
  oldPassword: string;

  @IsNotEmpty({ message: '新密码不能为空' })
  @IsString({ message: '新密码必须是字符串' })
  @MinLength(6, { message: '新密码长度不能少于6位' })
  @MaxLength(20, { message: '新密码长度不能超过20位' })
  // @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/, {
  //   message: '新密码必须包含大小写字母、数字和特殊字符',
  // })
  newPassword: string;

  @IsNotEmpty({ message: '确认密码不能为空' })
  @IsString({ message: '确认密码必须是字符串' })
  confirmPassword: string;
}

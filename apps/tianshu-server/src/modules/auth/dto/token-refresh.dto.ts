import { IsNotEmpty, IsString } from 'class-validator';

export class TokenRefreshDto {
  @IsNotEmpty({ message: '刷新令牌不能为空' })
  @IsString({ message: '刷新令牌必须是字符串' })
  refreshToken: string;
}

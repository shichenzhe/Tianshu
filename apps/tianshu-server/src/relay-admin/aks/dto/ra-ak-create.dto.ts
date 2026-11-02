import {
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';

/** AK 角色（spec §5.2 role 分离：server/client 泄露面隔离、吊销粒度到角色） */
export const AK_ROLES = ['server', 'client'];

/** relay-admin 签发 AK 请求 DTO。expireAt 上送 ISO 8601 字符串（house 惯例
 * ——session-query DTO 同款，服务层再 new Date()；缺省 now+365d） */
export class RaAkCreateDto {
  @IsNotEmpty({ message: '用户ID不能为空' })
  @IsString({ message: '用户ID必须是字符串' })
  userId: string;

  @IsIn(AK_ROLES, { message: `角色必须是 ${AK_ROLES.join('/')} 之一` })
  role: string;

  @IsOptional()
  @IsDateString(
    {},
    { message: '过期时间必须是合法日期字符串（ISO 8601）' },
  )
  expireAt?: string;
}

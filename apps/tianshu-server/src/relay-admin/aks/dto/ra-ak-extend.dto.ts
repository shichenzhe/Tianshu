import { IsDateString, IsNotEmpty } from 'class-validator';

/** relay-admin AK 续期请求 DTO：expireAt 只能延后（服务层校验语义与现有值
 * 比较，早于现有值抛 BusinessException） */
export class RaAkExtendDto {
  @IsNotEmpty({ message: '过期时间不能为空' })
  @IsDateString(
    {},
    { message: '过期时间必须是合法日期字符串（ISO 8601）' },
  )
  expireAt: string;
}

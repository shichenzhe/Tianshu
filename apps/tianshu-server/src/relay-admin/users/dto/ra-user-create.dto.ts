import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/** 当前开放的套餐档位（spec §6：beta 单档 maxServers=5/maxClients=10）。
 * 扩档时此处与 Task 11 aks 的 PLAN_QUOTA 映射同步增补 */
export const RA_PLANS = ['beta'];

/** 建户缺省档位（schema 侧另有 @default("beta") 双保险） */
export const RA_DEFAULT_PLAN = 'beta';

/** relay-admin 建户请求 DTO（校验口径对齐业务端 UserCreateDto 风格；
 * name 不唯一——租户标识是 tenantId，重名允许） */
export class RaUserCreateDto {
  @IsNotEmpty({ message: '用户名不能为空' })
  @IsString({ message: '用户名必须是字符串' })
  @MaxLength(255, { message: '用户名长度不能超过255位' })
  name: string;

  @IsOptional()
  @IsIn(RA_PLANS, { message: `套餐必须是 ${RA_PLANS.join('/')} 之一` })
  plan?: string;
}

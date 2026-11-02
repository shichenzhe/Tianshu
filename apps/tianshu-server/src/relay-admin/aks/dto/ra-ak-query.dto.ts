import { IsNotEmpty, IsString } from 'class-validator';

/** relay-admin AK 列表查询 DTO：按 userId 过滤（AK 数量不限，管理面按租户
 * 视图检索；beta 量级不分页——收费档位上线时与 users 列表同步引入） */
export class RaAkListQueryDto {
  @IsNotEmpty({ message: '用户ID不能为空' })
  @IsString({ message: '用户ID必须是字符串' })
  userId: string;
}

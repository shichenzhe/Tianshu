import { IsNotEmpty } from 'class-validator';
import { Entity } from 'src/commons/entity/entity';

/**
 * 创建用户DTO
 */
export class UserActiveDto extends Entity {
  @IsNotEmpty({ message: '用户状态不能为空' })
  isActive: boolean;
}

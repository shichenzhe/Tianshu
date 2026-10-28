import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsNotEmpty, IsOptional } from 'class-validator';

/**
 * 会话权限模式载荷（get/set 合一）：mode 缺省=查询当前值；携带=设置
 */
export class SessionAccessModeDto {
  @ApiProperty({ description: '会话标识' })
  @IsNotEmpty({ message: '会话标识不能为空' })
  @IsInt({ message: '会话标识必须是整数' })
  sessionId: number;

  @ApiProperty({
    description: '权限模式 default|full（缺省=仅查询）',
    required: false,
  })
  @IsOptional()
  @IsIn(['default', 'full'], { message: '权限模式必须是 default|full' })
  mode?: 'default' | 'full';
}

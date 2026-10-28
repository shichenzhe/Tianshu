import { ApiProperty } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/**
 * 会话更新载荷（重命名+模式切换——CU 批扩 mode；title/mode 至少一项，
 * service 侧守卫）
 */
export class SessionUpdateDto {
  @ApiProperty({ description: '会话标识' })
  @IsNotEmpty({ message: '会话标识不能为空' })
  @IsInt({ message: '会话标识必须是整数' })
  sessionId: number;

  @ApiProperty({ description: '新标题（trim 后非空）', required: false })
  @IsOptional()
  @IsString({ message: '标题必须是字符串' })
  @MaxLength(255, { message: '标题长度不能超过255位' })
  title?: string;

  @ApiProperty({
    description: '会话模式 agent|ask|plan（ask=纯问答无工具）',
    required: false,
  })
  @IsOptional()
  @IsIn(['agent', 'ask', 'plan'], { message: '模式必须是 agent|ask|plan' })
  mode?: 'agent' | 'ask' | 'plan';

  @ApiProperty({ description: '归档切换（true=归档只读）', required: false })
  @IsOptional()
  @IsIn([true, false], { message: '归档必须是布尔' })
  archived?: boolean;

  @ApiProperty({ description: '置顶切换（true=列表前置）', required: false })
  @IsOptional()
  @IsIn([true, false], { message: '置顶必须是布尔' })
  pinned?: boolean;

  @ApiProperty({ description: '绑定专家（null=不使用助手）', required: false })
  @ValidateIf((o) => o.assistantId !== null)
  @IsOptional()
  @IsInt({ message: '专家标识必须是整数' })
  assistantId?: number | null;

  @ApiProperty({
    description: '会话当前模型（null=清除走回退链）',
    required: false,
  })
  @ValidateIf((o) => o.currentModelId !== null)
  @IsOptional()
  @IsInt({ message: '模型行标识必须是整数' })
  currentModelId?: number | null;
}

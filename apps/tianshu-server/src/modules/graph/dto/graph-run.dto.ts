import { IsInt, IsObject, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * 图试运行DTO（spec §4.1：{graphId, inputs?}；workspaceId 可选——缺省挂
 * 用户最近一个空间（session create 同口径），显式携带则校验归属）。
 * inputs 仅校验对象形态：键值经模板渲染消费，非字符串值自然字符串化
 * （mirror IPC 裸 JSON 直传同款，不深校验）
 */
export class GraphRunDto {
  @ApiProperty({ description: '图标识' })
  @IsInt({ message: '图标识必须是整数' })
  graphId: number;

  @ApiProperty({
    description:
      '输入变量（inputSchema 键值；缺省空）——typed 值（number/boolean）经入口归一为原生类型（D 批共享 normalizeGraphInputs）',
    // SK-2 契约测试暴露：裸 type:object 无 additionalProperties 时
    // openapi-typescript 生成退化形 Record<string, never>（值域禁写入）；
    // 值域对齐 chat 工具 typed 上送（HTTP 侧 @IsObject 不深校验，行为不变）
    required: false,
    type: Object,
    additionalProperties: {
      anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
    },
  })
  @IsOptional()
  @IsObject({ message: '输入变量必须是键值对象' })
  inputs?: Record<string, string | number | boolean>;

  @ApiProperty({
    description: '工作空间；缺省挂用户最近一个空间',
    required: false,
  })
  @IsOptional()
  @IsInt({ message: '工作空间标识必须是整数' })
  workspaceId?: number;
}

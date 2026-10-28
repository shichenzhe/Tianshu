import { ApiProperty } from '@nestjs/swagger';
import type { AssistantBrief } from '@tianshu/protocol';

/**
 * 专家概要行 wire 响应DTO（SDK 响应面批）：wire 形状 = 协议包
 * AssistantBrief（class implements 编译期绑定——协议改形此处编译红）。
 * 字段以 assistant.service.query 实际返回为准（icon/quickPrompts 为
 * 查询期解析列——quickPrompts JSON 串坏数据回退 null）。
 */
export class AssistantBriefWireDto implements AssistantBrief {
  @ApiProperty({ description: '专家标识' })
  id: number;

  @ApiProperty({ description: '专家名称' })
  name: string;

  @ApiProperty({
    description: '描述（概要面恒 null——占位对齐协议形状）',
    nullable: true,
  })
  description: string | null;

  @ApiProperty({ description: '图标 emoji', nullable: true })
  icon: string | null;

  @ApiProperty({
    description: '提示词胶囊（JSON 列解析；坏数据回退 null）',
    type: [String],
    nullable: true,
  })
  quickPrompts: string[] | null;
}

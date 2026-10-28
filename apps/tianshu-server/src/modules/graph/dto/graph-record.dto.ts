import { ApiProperty } from '@nestjs/swagger';
import type { GraphRecord } from '@tianshu/protocol';

/**
 * 图定义记录响应DTO（SK-R 批）：wire 形状 = 协议包 GraphRecord（class
 * implements 编译期绑定——协议改形此处编译红，witness 零成本）
 */
export class GraphRecordDto implements GraphRecord {
  @ApiProperty({ description: '图标识' })
  id: number;

  @ApiProperty({ description: '图名称' })
  name: string;

  @ApiProperty({ description: '描述', required: false })
  description?: string;

  @ApiProperty({ description: '图定义 JSON 原样字符串' })
  graphJson: string;

  @ApiProperty({ description: '乐观锁版本（编辑保存需携带）' })
  version: number;

  @ApiProperty({ description: '启用状态' })
  enabled: boolean;

  @ApiProperty({ description: '创建时间（ISO）' })
  createdAt: string;

  @ApiProperty({ description: '更新时间（ISO）' })
  updatedAt: string;

  @ApiProperty({ description: '节点数（历史脏行容错 0）' })
  nodeCount: number;
}

import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty } from 'class-validator';

/**
 * 会话压缩载荷（A9 会话内工具批，spec 2026-10-26 §1 阶段 2：{sessionId}）。
 * 异步语义对齐 send 先例：202 受理即返回，被控端后台执行——清旧压缩态 →
 * 摘要指令走普通轮 → 回填 summary/compactedUpToId；完成后经
 * session.updated 事件刷新（控制端重拉 getById）
 */
export class SessionCompactDto {
  @ApiProperty({ description: '会话标识' })
  @IsNotEmpty({ message: '会话标识不能为空' })
  @IsInt({ message: '会话标识必须是整数' })
  sessionId: number;
}

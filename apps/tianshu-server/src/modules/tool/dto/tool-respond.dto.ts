import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDefined,
  IsString,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { BridgeToolResult } from '@tianshu/protocol';

/**
 * 桥工具结果 DTO（spec §2.2）：ok=true 需 output 字符串、ok=false 需
 * error 字符串——@ValidateIf 声明式自洽校验（缺字段经 ValidationPipe 统一
 * 拒绝，本仓异常过滤器映射 5000 + 字段名消息）。
 * 声明先于 ToolRespondDto（嵌套类型 emitDecoratorMetadata 急取类值，
 * 后置会 TDZ ReferenceError——启动即炸，实测锚点）。
 *
 * TB-T3：result 的权威类型上提 @tianshu/protocol 单份（BridgeToolResult，
 * mirror bridge-executor / server bridge-registry 同引）；本类为该判别
 * 联合的 HTTP 运行时校验面（class-validator 需类形态，无法直接引用联合
 * 类型）——字段集/判别键与协议单份对齐，收敛经下方 toBridgeToolResult
 * 落到协议单份（返回类型即权威形，形变即编译期红）。
 */
export class BridgeToolResultDto {
  @ApiProperty({ description: '执行成功与否' })
  @IsBoolean()
  ok: boolean;

  @ApiProperty({
    description: '成功时的工具输出（模型回喂面）',
    // SK-2 契约测试暴露：ValidateIf 条件字段缺 required:false 会被 schema
    // 误标必填——生成类型将强制 ok:true 应答也带 error（与协议
    // BridgeToolResult 判别联合漂移）
    required: false,
  })
  @ValidateIf((object: BridgeToolResultDto) => object.ok === true)
  @IsString()
  output?: string;

  @ApiProperty({
    description: '失败时的错误说明（控制端拒绝/执行失败）',
    required: false,
  })
  @ValidateIf((object: BridgeToolResultDto) => object.ok === false)
  @IsString()
  error?: string;
}

/**
 * 桥应答 DTO（spec §2.2）：requestId 一次性匹配键 + result 判别形状。
 */
export class ToolRespondDto {
  @ApiProperty({ description: 'tool.request 携带的一次性请求 id' })
  @IsString()
  requestId: string;

  @ApiProperty({ description: '桌面执行结果' })
  @IsDefined()
  @ValidateNested()
  @Type(() => BridgeToolResultDto)
  result: BridgeToolResultDto;
}

/** DTO（output/error 可选）→ 协议单份收敛结果（缺字段已由 ValidateIf 拒） */
export function toBridgeToolResult(dto: BridgeToolResultDto): BridgeToolResult {
  return dto.ok
    ? { ok: true, output: dto.output ?? '' }
    : { ok: false, error: dto.error ?? '' };
}

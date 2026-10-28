import { ApiProperty } from '@nestjs/swagger';
import type { Model, Provider } from '@prisma/client';
import { ProviderWireDto, ModelWireDto } from './provider-wire.dto';

/**
 * 模型配置查询结果DTO（providers + models 全量，经 providerId 关联）。
 * 字段 wire 形状（SK-R 批：prisma class 直引会令 swagger 展开爆栈）
 */
export class ProviderBundleDto {
  @ApiProperty({ description: '服务商列表', type: [ProviderWireDto] })
  providers: ProviderWireDto[];

  @ApiProperty({ description: '模型列表', type: [ModelWireDto] })
  models: ModelWireDto[];

  constructor(partial: Partial<ProviderBundleDto>) {
    Object.assign(this, partial);
  }

  /** prisma 行集 → wire（Date→ISO；query/save/delete 三端点同出口。
   * 返回对象与 wire DTO 字段一一对应，经 unknown 断言收口（Date 与
   * ISO string 异构——wire 化正是转换点） */
  static of(providers: Provider[], models: Model[]): ProviderBundleDto {
    const wireRow = <T extends { createdAt: Date; updatedAt: Date }>(
      row: T,
    ): Record<string, unknown> => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });
    return {
      providers: providers.map(wireRow),
      models: models.map(wireRow),
    } as unknown as ProviderBundleDto;
  }
}

import { Injectable } from '@nestjs/common';
import { Provider } from '@prisma/client';
import { REDACTED_SECRET } from '@tianshu/protocol';
import { COMPANION_USER_ID } from 'src/commons/config/tianshu-config.entity';
import { ProviderRepository } from './provider.repository';
import { ProviderSaveDto } from './dto/provider-save.dto';
import { ProviderDeleteDto } from './dto/provider-delete.dto';
import { ProviderTargetDto } from './dto/provider-target.dto';
import { ProviderBundleDto } from './dto/provider-bundle.dto';

/**
 * extraHeaders 脱敏：JSON 字符串解析后逐值掩码（键名保留）。A1 终审 F1
 * 收紧为 fail-closed：非纯对象整体掩码；对象内任何非 string 值也掩码，
 * 防止数组/标量/嵌套结构绕开脱敏回泄秘密。空串/解析失败原样，null 透传。
 */
function redactExtraHeaders(raw: string | null): string | null {
  if (typeof raw !== 'string' || raw === '') return raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return REDACTED_SECRET;
  }
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    redacted[key] =
      typeof value === 'string' && value === '' ? value : REDACTED_SECRET;
  }
  return JSON.stringify(redacted);
}

/**
 * provider 行脱敏（M5 终审安全项，与 mirror server-face 同口径）：
 * apiKey/extraHeaders 有值以 REDACTED_SECRET 掩码替换（空与已配置可
 * 区分），relay 明文链路不再暴露密钥；消费方（移动端/远控台）只读展示
 * 字段，save 回传掩码由 repository 按未传处理防回写。
 */
function redactProvider(provider: Provider): Provider {
  return {
    ...provider,
    apiKey: provider.apiKey ? REDACTED_SECRET : provider.apiKey,
    extraHeaders: redactExtraHeaders(provider.extraHeaders),
  };
}

/**
 * 模型配置服务（userId 伴生写死 1，见 COMPANION_USER_ID 头注释）
 */
@Injectable()
export class ProviderService {
  constructor(private readonly providerRepository: ProviderRepository) {}

  /**
   * 查询模型配置全量（providers + models）；providers 密钥字段脱敏
   */
  async query(): Promise<ProviderBundleDto> {
    const [providers, models] = await Promise.all([
      this.providerRepository.listProviders(COMPANION_USER_ID),
      this.providerRepository.listModels(COMPANION_USER_ID),
    ]);
    return ProviderBundleDto.of(providers.map(redactProvider), models);
  }

  /**
   * 保存模型配置（upsert 数组语义），返回保存后全量状态（同口径脱敏）
   */
  async save(dto: ProviderSaveDto): Promise<ProviderBundleDto> {
    await this.providerRepository.save(dto, COMPANION_USER_ID);
    return await this.query();
  }

  /**
   * 批量删除（providerIds 级联 / modelIds 单删），返回删除后全量
   */
  async delete(dto: ProviderDeleteDto): Promise<ProviderBundleDto> {
    await this.providerRepository.delete(dto, COMPANION_USER_ID);
    return await this.query();
  }

  /**
   * 连通测试（轻探上游；失败原因结构化转 message）
   */
  async test(
    dto: ProviderTargetDto,
  ): Promise<{ ok: boolean; message: string }> {
    const ok = await this.providerRepository.test(
      dto.providerId,
      COMPANION_USER_ID,
    );
    return { ok, message: ok ? '' : '上游不可达或鉴权失败' };
  }

  /**
   * 拉取上游模型清单（连通失败为预期结果——结构化透传）
   */
  async fetchModels(dto: ProviderTargetDto) {
    return await this.providerRepository.fetchModels(
      dto.providerId,
      COMPANION_USER_ID,
    );
  }
}

import { Injectable } from '@nestjs/common';
import { Model, Prisma, Provider } from '@prisma/client';
import { REDACTED_SECRET } from '@tianshu/protocol';
import { PrismaService } from 'src/commons/database/prisma.service';
import { BusinessException } from 'src/commons/exception/bussiness-exception';
import { ErrorCodeEnum } from 'src/commons/exception/error-code.enum';
import { ModelItemDto, ProviderItemDto } from './dto/provider-save.dto';

/**
 * 模型配置仓库（provider/model 两表，relationMode=prisma 无外键，
 * model 无 userId 冗余列，归属经所属 provider 链路校验——mirror 同款语义）。
 *
 * save 为一期 upsert 数组语义（带 id 更新/不带 id 新建，无删除维度），
 * 全批走交互式事务：任一项校验失败整批回滚（业务异常需在事务内抛出以保证原子性，
 * 此处 repository 抛业务异常为该事务场景的有意分层例外）。
 */
@Injectable()
export class ProviderRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 服务商全量（按创建时间倒序，mirror provider:list 同款）
   */
  async listProviders(userId: number): Promise<Provider[]> {
    return await this.prisma.provider.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * 模型全量（经所属 provider 过滤，mirror model:listAll 同款）
   */
  async listModels(userId: number): Promise<Model[]> {
    const providers = await this.prisma.provider.findMany({
      where: { userId },
      select: { id: true },
    });
    return await this.prisma.model.findMany({
      where: { providerId: { in: providers.map((provider) => provider.id) } },
      orderBy: [{ providerId: 'asc' }, { createdAt: 'desc' }],
    });
  }

  /**
   * 保存模型配置（upsert 数组，事务内逐项校验归属后落库）
   */
  async save(
    dto: { providers?: ProviderItemDto[]; models?: ModelItemDto[] },
    userId: number,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      for (const item of dto.providers ?? []) {
        await this.upsertProvider(tx, item, userId);
      }
      for (const item of dto.models ?? []) {
        await this.upsertModel(tx, item, userId);
      }
    });
  }

  private async upsertProvider(
    tx: Prisma.TransactionClient,
    item: ProviderItemDto,
    userId: number,
  ): Promise<void> {
    // 掩码回写防御（M5，与 provider/query 脱敏配套）：控制端把脱敏响应
    // 原样 save 回传时——apiKey 整串即掩码、extraHeaders 为含掩码值的
    // JSON（或整串掩码）——按未传处理（更新保持现值、新建落空值），
    // 防脱敏值覆盖真实密钥
    const apiKey = item.apiKey === REDACTED_SECRET ? undefined : item.apiKey;
    const extraHeaders =
      typeof item.extraHeaders === 'string' &&
      item.extraHeaders.includes(REDACTED_SECRET)
        ? undefined
        : item.extraHeaders;
    if (item.id != null) {
      const existing = await tx.provider.findFirst({
        where: { id: item.id, userId },
      });
      if (!existing) {
        throw new BusinessException('服务商不存在', ErrorCodeEnum.NOT_FOUND);
      }
      await tx.provider.update({
        where: { id: item.id },
        data: {
          name: item.name,
          type: item.type,
          baseUrl: item.baseUrl,
          // 未传（undefined）保留现值；显式传 null 才清除（F4-1）
          apiKey: apiKey === undefined ? existing.apiKey : apiKey,
          extraHeaders:
            extraHeaders === undefined ? existing.extraHeaders : extraHeaders,
          enabled: item.enabled ?? existing.enabled,
        },
      });
      return;
    }
    await tx.provider.create({
      data: {
        name: item.name,
        type: item.type,
        baseUrl: item.baseUrl,
        apiKey: apiKey ?? null,
        extraHeaders: extraHeaders ?? null,
        enabled: item.enabled ?? true,
        userId,
      },
    });
  }

  private async upsertModel(
    tx: Prisma.TransactionClient,
    item: ModelItemDto,
    userId: number,
  ): Promise<void> {
    // 归属校验：目标 provider 必须属于该用户（model 自身无 userId 列）
    const provider = await tx.provider.findFirst({
      where: { id: item.providerId, userId },
    });
    if (!provider) {
      throw new BusinessException('服务商不存在', ErrorCodeEnum.NOT_FOUND);
    }

    if (item.id != null) {
      const existing = await tx.model.findFirst({
        where: { id: item.id, providerId: item.providerId },
      });
      if (!existing) {
        throw new BusinessException('模型不存在', ErrorCodeEnum.NOT_FOUND);
      }
      await tx.model.update({
        where: { id: item.id },
        data: this.toModelData(item, existing),
      });
      return;
    }
    await tx.model.create({
      data: this.toModelData(item),
    });
  }

  /** 组装 model 落库字段：undefined 保留现值，null 显式清除（A1 终审 F3） */
  private toModelData(item: ModelItemDto, existing?: Model) {
    return {
      providerId: item.providerId,
      modelId: item.modelId,
      name: item.name === undefined ? (existing?.name ?? null) : item.name,
      type: item.type ?? existing?.type ?? 'llm',
      enabled: item.enabled ?? existing?.enabled ?? true,
      temperature:
        item.temperature === undefined
          ? (existing?.temperature ?? null)
          : item.temperature,
      topP: item.topP === undefined ? (existing?.topP ?? null) : item.topP,
      maxTokens:
        item.maxTokens === undefined
          ? (existing?.maxTokens ?? null)
          : item.maxTokens,
      contextWindow:
        item.contextWindow === undefined
          ? (existing?.contextWindow ?? null)
          : item.contextWindow,
    };
  }

  /**
   * 批量删除（provider/delete 载荷）：providerIds 级联清其 models 再删
   * 行（mirror provider.repo.delete 同款语义）；modelIds 单删。归属
   * 校验先行（不属于该用户的 id 静默跳过——删除幂等）
   */
  async delete(
    dto: { providerIds?: number[]; modelIds?: number[] },
    userId: number,
  ): Promise<void> {
    // model 归属判定用：该用户全部 provider id 集（无 relation 字段）
    const providerIdSet = (
      await this.prisma.provider.findMany({
        where: { userId },
        select: { id: true },
      })
    ).map((p) => p.id);
    await this.prisma.$transaction(async (tx) => {
      for (const id of dto.providerIds ?? []) {
        const owned = await tx.provider.findFirst({
          where: { id, userId },
          select: { id: true },
        });
        if (!owned) continue;
        await tx.model.deleteMany({ where: { providerId: id } });
        await tx.provider.delete({ where: { id } });
      }
      for (const id of dto.modelIds ?? []) {
        // relationMode=prisma 无 relation 字段——经 providerId 归属集判定
        const owned = await tx.model.findFirst({
          where: { id, providerId: { in: providerIdSet } },
          select: { id: true },
        });
        if (!owned) continue;
        await tx.model.delete({ where: { id } });
      }
    });
  }

  /**
   * 连通测试（provider/test 载荷 {providerId}）：轻探上游 /models——
   * 可达且鉴权通过即 ok（不发起对话计费；desktop 被面为本地对话测试，
   * 两端口径差异见协议 ProviderTestResult 注）
   */
  async test(providerId: number, userId: number): Promise<boolean> {
    const provider = await this.findOwnedRuntimeInfo(providerId, userId);
    const upstream = await this.fetchUpstreamModels(provider);
    return upstream.success;
  }

  /**
   * 拉取上游模型清单（provider/fetchModels 载荷 {providerId}）：连通失败
   * 是预期结果——结构化 success/errorCode 语义对齐 mirror listRemote
   */
  async fetchModels(
    providerId: number,
    userId: number,
  ): Promise<{
    success: boolean;
    errorCode?: string;
    message: string;
    models: Array<{ modelId: string; name?: string }>;
  }> {
    const provider = await this.findOwnedRuntimeInfo(providerId, userId);
    return this.fetchUpstreamModels(provider);
  }

  /** 归属校验 + 运行时信息（baseUrl/apiKey/extraHeaders/type） */
  private async findOwnedRuntimeInfo(providerId: number, userId: number) {
    const provider = await this.prisma.provider.findFirst({
      where: { id: providerId, userId },
    });
    if (!provider) {
      throw new BusinessException('服务商不存在', ErrorCodeEnum.NOT_FOUND);
    }
    return provider;
  }

  /** 上游 /models 拉取（openai-compatible 与 ollama 两型；其余类型
   * 结构化不支持）。5s 超时；错误归类 message 携原文 */
  private async fetchUpstreamModels(provider: Provider): Promise<{
    success: boolean;
    errorCode?: string;
    message: string;
    models: Array<{ modelId: string; name?: string }>;
  }> {
    try {
      let url: string;
      const headers: Record<string, string> = {};
      if (provider.type === 'ollama') {
        url = `${provider.baseUrl.replace(/\/+$/, '')}/api/tags`;
      } else {
        url = `${provider.baseUrl.replace(/\/+$/, '')}/models`;
        if (provider.apiKey) {
          headers.Authorization = `Bearer ${provider.apiKey}`;
        }
      }
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        return {
          success: false,
          errorCode: String(res.status),
          message: `HTTP ${res.status}`,
          models: [],
        };
      }
      const body = (await res.json()) as {
        data?: Array<{ id: string; name?: string }>;
        models?: Array<{ name: string; model?: string }>;
      };
      const models =
        provider.type === 'ollama'
          ? (body.models ?? []).map((m) => ({
              modelId: m.name ?? m.model ?? '',
            }))
          : (body.data ?? []).map((m) => ({
              modelId: m.id,
              ...(m.name ? { name: m.name } : {}),
            }));
      return { success: true, message: '', models };
    } catch (e) {
      return {
        success: false,
        errorCode: 'UNREACHABLE',
        message: String(e instanceof Error ? e.message : e),
        models: [],
      };
    }
  }
}

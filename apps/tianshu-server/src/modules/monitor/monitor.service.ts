/**
 * 监控统计服务（MO 批 2026-10-27）：monitor/stats 聚合查询——7 天窗口
 * llm/tool 两查 + model 名补位 + computeMonitorStats 内存聚合
 * （mirror MonitorRepository.getStats 同构；compute 已收编 @tianshu/core
 * 单源）。单伴生用户面（COMPANION_USER_ID）。
 * P0-2（2026-11-05，spec monitoring.md §6）：事件保留期裁剪——对齐桌面
 * ensureEventStatMaintenance 的 cutoff 口径（createdAt < now - 90 天，
 * 无 userId 过滤）；server 长驻进程启动即裁一次 + 每日 setInterval 周期
 * 跑（桌面只在启动时裁一次，长驻数周期间不清理的缺口在 server 侧补齐）。
 */
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { MonitorScene, MonitorStats } from '@tianshu/protocol';
import { computeMonitorStats } from '@tianshu/core';
import { PrismaService } from 'src/commons/database/prisma.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 7;

/** 事件保留期（天）：与桌面 ensureEventStatMaintenance 同值 */
export const MONITOR_RETENTION_DAYS = 90;

/** 裁剪周期（ms）：每日（常量导出便于测试断言） */
export const MONITOR_PRUNE_INTERVAL_MS = DAY_MS;

const SCENES: MonitorScene[] = ['chat', 'graph', 'automation'];

@Injectable()
export class MonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MonitorService.name);
  private pruneTimer?: NodeJS.Timeout;

  constructor(private readonly prisma: PrismaService) {}

  /** 启动即裁一次 + 每日周期裁（fire-and-forget，失败记日志不阻塞） */
  onModuleInit(): void {
    void this.runPrune();
    this.pruneTimer = setInterval(() => {
      void this.runPrune();
    }, MONITOR_PRUNE_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = undefined;
    }
  }

  private async runPrune(): Promise<void> {
    try {
      const deleted = await this.pruneMonitorEvents();
      if (deleted > 0) {
        this.logger.log(`监控事件保留期裁剪：删除 ${deleted} 行`);
      }
    } catch (e) {
      this.logger.warn('监控事件保留期裁剪失败', e);
    }
  }

  /**
   * 事件保留期裁剪：llm/tool 两表 createdAt < cutoff 的行删除，
   * 返回删除总数（幂等——二次调用零命中返回 0）
   */
  async pruneMonitorEvents(
    cutoffDays: number = MONITOR_RETENTION_DAYS,
  ): Promise<number> {
    const cutoff = new Date(Date.now() - cutoffDays * DAY_MS);
    const [llm, tool] = await Promise.all([
      this.prisma.llmCallEvent.deleteMany({
        where: { createdAt: { lt: cutoff } },
      }),
      this.prisma.toolCallEvent.deleteMany({
        where: { createdAt: { lt: cutoff } },
      }),
    ]);
    return llm.count + tool.count;
  }

  async getStats(userId: number, scene?: MonitorScene): Promise<MonitorStats> {
    const since = new Date(Date.now() - WINDOW_DAYS * DAY_MS);
    const where = {
      userId,
      createdAt: { gte: since },
      ...(scene ? { scene } : {}),
    };
    const [llmRows, toolRows] = await Promise.all([
      this.prisma.llmCallEvent.findMany({
        where,
        select: {
          modelId: true,
          inputTokens: true,
          outputTokens: true,
          createdAt: true,
        },
      }),
      this.prisma.toolCallEvent.findMany({
        where,
        select: {
          toolName: true,
          state: true,
          durationMs: true,
          createdAt: true,
        },
      }),
    ]);
    const modelIds = [
      ...new Set(
        llmRows.map((r) => r.modelId).filter((id): id is number => id !== null),
      ),
    ];
    const models = modelIds.length
      ? await this.prisma.model.findMany({
          where: { id: { in: modelIds } },
          select: { id: true, name: true, modelId: true },
        })
      : [];
    return computeMonitorStats(llmRows, toolRows, models, new Date());
  }
}

export function isMonitorScene(value: unknown): value is MonitorScene {
  return typeof value === 'string' && SCENES.includes(value as MonitorScene);
}

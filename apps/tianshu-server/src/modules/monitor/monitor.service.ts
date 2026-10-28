/**
 * 监控统计服务（MO 批 2026-10-27）：monitor/stats 聚合查询——7 天窗口
 * llm/tool 两查 + model 名补位 + computeMonitorStats 内存聚合
 * （mirror MonitorRepository.getStats 同构；compute 已收编 @tianshu/core
 * 单源）。单伴生用户面（COMPANION_USER_ID）。
 */
import { Injectable } from '@nestjs/common';
import type { MonitorScene, MonitorStats } from '@tianshu/protocol';
import { computeMonitorStats } from '@tianshu/core';
import { PrismaService } from 'src/commons/database/prisma.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 7;

const SCENES: MonitorScene[] = ['chat', 'graph', 'automation'];

@Injectable()
export class MonitorService {
  constructor(private readonly prisma: PrismaService) {}

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

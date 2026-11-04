/**
 * 监控仓储（spec §5）：monitor:stats 聚合查询——7 天窗口三查
 * findMany（llm/tool/模型名联查补位）+ computeMonitorStats 内存聚合。
 */
import prisma from "../../../commons/prisma-client";
import { handleUser } from "../../../commons/ipc-user";
import type { MonitorScene, MonitorStats } from "@tianshu/protocol";
import { computeMonitorStats } from "./monitor-stats";

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 7;

const SCENES: MonitorScene[] = ["chat", "graph", "automation"];

export class MonitorRepository {
  constructor() {
    handleUser("monitor:stats", (_, userId: number, scene?: string) =>
      this.getStats(
        userId,
        SCENES.includes(scene as MonitorScene)
          ? (scene as MonitorScene)
          : undefined,
      ),
    );
  }

  async getStats(userId: number, scene?: MonitorScene): Promise<MonitorStats> {
    const since = new Date(Date.now() - WINDOW_DAYS * DAY_MS);
    const where = {
      userId,
      createdAt: { gte: since },
      ...(scene ? { scene } : {}),
    };
    const [llmRows, toolRows] = await Promise.all([
      prisma.llmCallEvent.findMany({
        where,
        select: {
          modelId: true,
          inputTokens: true,
          outputTokens: true,
          createdAt: true,
        },
      }),
      prisma.toolCallEvent.findMany({
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
      ? await prisma.model.findMany({
          where: { id: { in: modelIds } },
          select: { id: true, name: true, modelId: true },
        })
      : [];
    return computeMonitorStats(llmRows, toolRows, models, new Date());
  }
}

export default MonitorRepository;

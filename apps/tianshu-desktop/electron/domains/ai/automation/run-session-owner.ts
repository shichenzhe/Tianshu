export interface RunSessionOwnerIds {
  taskIds?: number[];
  graphIds?: number[];
}

type SessionOwnerFilter =
  | { id: { in: number[] } }
  | { automationTaskId: { in: number[] } }
  | { runGraphId: { in: number[] } };

export interface RunSessionOwnerRow {
  id: number;
  sessionId: number | null;
  taskId: number | null;
  graphId: number | null;
}

/** 窄面注入，避免回填/事务清理反向依赖全局 Prisma 单例。 */
export interface RunSessionOwnerDb {
  automationRun: {
    findMany(args: {
      where: {
        id?: { in: number[] };
        sessionId?: { not: null };
        taskId?: { not: null };
        graphId?: null;
        status?: string | { notIn: string[] };
        startedAt?: { lt: Date };
      };
      select: {
        id: true;
        sessionId: true;
        taskId: true;
        graphId: true;
      };
    }): Promise<RunSessionOwnerRow[]>;
  };
  session: {
    updateMany(args: {
      where: { id?: { in: number[] }; OR?: SessionOwnerFilter[] };
      data: {
        automationTaskId: number | null;
        runGraphId: number | null;
      };
    }): Promise<{ count: number }>;
  };
}

/** 运行删除前解除会话聚合归属；会话与消息本身保留为普通聊天。 */
export async function clearRunSessionOwners(
  db: RunSessionOwnerDb,
  runIds: number[],
  owners: RunSessionOwnerIds = {},
): Promise<void> {
  if (
    runIds.length === 0 &&
    !owners.taskIds?.length &&
    !owners.graphIds?.length
  ) {
    return;
  }
  const runs = runIds.length
    ? await db.automationRun.findMany({
        where: { id: { in: runIds } },
        select: { id: true, sessionId: true, taskId: true, graphId: true },
      })
    : [];
  const sessionIds = [
    ...new Set(
      runs
        .map((run) => run.sessionId)
        .filter((id): id is number => typeof id === "number"),
    ),
  ];
  const filters: SessionOwnerFilter[] = [
    ...(sessionIds.length ? [{ id: { in: sessionIds } }] : []),
    ...(owners.taskIds?.length
      ? [{ automationTaskId: { in: owners.taskIds } }]
      : []),
    ...(owners.graphIds?.length
      ? [{ runGraphId: { in: owners.graphIds } }]
      : []),
  ];
  if (filters.length === 0) return;
  await db.session.updateMany({
    where: { OR: filters },
    data: { automationTaskId: null, runGraphId: null },
  });
}

/** 仅从仍存在的 prompt run 回填任务归属；无 run 的旧会话保持普通会话。 */
export async function backfillRunSessionOwners(
  db: RunSessionOwnerDb,
): Promise<void> {
  const runs = await db.automationRun.findMany({
    where: { sessionId: { not: null }, taskId: { not: null }, graphId: null },
    select: { id: true, sessionId: true, taskId: true, graphId: true },
  });
  const sessionIdsByTask = new Map<number, number[]>();
  for (const run of runs) {
    if (typeof run.sessionId !== "number" || typeof run.taskId !== "number") {
      continue;
    }
    const ids = sessionIdsByTask.get(run.taskId) ?? [];
    ids.push(run.sessionId);
    sessionIdsByTask.set(run.taskId, ids);
  }
  for (const [taskId, sessionIds] of sessionIdsByTask) {
    await db.session.updateMany({
      where: { id: { in: [...new Set(sessionIds)] } },
      data: { automationTaskId: taskId, runGraphId: null },
    });
  }
}

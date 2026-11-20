export interface RunSessionOwnerIds {
  taskIds?: number[];
  graphIds?: number[];
}

type SessionOwnerFilter =
  | { id: { in: number[] } }
  | { automationTaskId: { in: number[] } }
  | { runGraphId: { in: number[] } };

export interface RunSessionOwnerDb {
  automationRun: {
    findMany(args: {
      where: { id: { in: number[] } };
      select: { sessionId: true };
    }): Promise<Array<{ sessionId: number | null }>>;
  };
  sessionRecord: {
    updateMany(args: {
      where: { OR: SessionOwnerFilter[] };
      data: { automationTaskId: null; runGraphId: null };
    }): Promise<{ count: number }>;
  };
}

/** run 删除前解除会话聚合归属；会话与消息保留为普通聊天。 */
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
        select: { sessionId: true },
      })
    : [];
  const sessionIds = [
    ...new Set(
      runs
        .map((run) => run.sessionId)
        .filter((id): id is number => typeof id === 'number'),
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
  await db.sessionRecord.updateMany({
    where: { OR: filters },
    data: { automationTaskId: null, runGraphId: null },
  });
}

export interface RunSessionOwnerDb {
  automationRun: {
    findMany(args: {
      where: { id: { in: number[] } };
      select: { sessionId: true };
    }): Promise<Array<{ sessionId: number | null }>>;
  };
  sessionRecord: {
    updateMany(args: {
      where: { id: { in: number[] } };
      data: { automationTaskId: null; runGraphId: null };
    }): Promise<{ count: number }>;
  };
}

/** run 删除前解除会话聚合归属；会话与消息保留为普通聊天。 */
export async function clearRunSessionOwners(
  db: RunSessionOwnerDb,
  runIds: number[],
): Promise<void> {
  if (runIds.length === 0) return;
  const runs = await db.automationRun.findMany({
    where: { id: { in: runIds } },
    select: { sessionId: true },
  });
  const sessionIds = [
    ...new Set(
      runs
        .map((run) => run.sessionId)
        .filter((id): id is number => typeof id === 'number'),
    ),
  ];
  if (sessionIds.length === 0) return;
  await db.sessionRecord.updateMany({
    where: { id: { in: sessionIds } },
    data: { automationTaskId: null, runGraphId: null },
  });
}

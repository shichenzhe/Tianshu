-- PostgreSQL 变体：与 SQLite migration 5 同构，标识符保留 camelCase。
ALTER TABLE "session" ADD COLUMN "automationTaskId" INTEGER;
ALTER TABLE "session" ADD COLUMN "runGraphId" INTEGER;
ALTER TABLE "automationRun" ADD COLUMN "workspaceId" INTEGER;

-- 先回填 prompt 归属：混合重复中较晚的 prompt run 也可提供任务 id。
UPDATE "session"
SET "automationTaskId" = (
  SELECT "automationRun"."taskId"
  FROM "automationRun"
  WHERE "automationRun"."sessionId" = "session"."id"
    AND "automationRun"."taskId" IS NOT NULL
    AND "automationRun"."graphId" IS NULL
  ORDER BY "automationRun"."id"
  LIMIT 1
)
WHERE EXISTS (
  SELECT 1
  FROM "automationRun"
  WHERE "automationRun"."sessionId" = "session"."id"
    AND "automationRun"."taskId" IS NOT NULL
    AND "automationRun"."graphId" IS NULL
);

-- 再去重：保留每个 sessionId 的最小 run id，其余仅解除链接。
UPDATE "automationRun"
SET "sessionId" = NULL
WHERE "sessionId" IS NOT NULL
  AND "id" NOT IN (
    SELECT MIN("id")
    FROM "automationRun"
    WHERE "sessionId" IS NOT NULL
    GROUP BY "sessionId"
  );

CREATE INDEX "session_automationTaskId_idx" ON "session"("automationTaskId");
CREATE INDEX "session_runGraphId_idx" ON "session"("runGraphId");
CREATE UNIQUE INDEX "automationRun_sessionId_key" ON "automationRun"("sessionId");

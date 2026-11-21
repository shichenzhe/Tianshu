-- PostgreSQL 变体：与 SQLite migration 5 同构，标识符保留 camelCase。
ALTER TABLE "session" ADD COLUMN "automationTaskId" INTEGER;
ALTER TABLE "session" ADD COLUMN "runGraphId" INTEGER;
ALTER TABLE "automationRun" ADD COLUMN "workspaceId" INTEGER;

-- 先去重：prompt run 优先且取最小 id；无 prompt run 时取最小 run id。
UPDATE "automationRun"
SET "sessionId" = NULL
WHERE "sessionId" IS NOT NULL
  AND "id" NOT IN (
    SELECT COALESCE(
      MIN(CASE
        WHEN "taskId" IS NOT NULL AND "graphId" IS NULL THEN "id"
      END),
      MIN("id")
    )
    FROM "automationRun"
    WHERE "sessionId" IS NOT NULL
    GROUP BY "sessionId"
  );

-- 再从同一 surviving canonical link 回填 prompt 归属。
UPDATE "session"
SET "automationTaskId" = (
  SELECT "automationRun"."taskId"
  FROM "automationRun"
  WHERE "automationRun"."sessionId" = "session"."id"
    AND "automationRun"."taskId" IS NOT NULL
    AND "automationRun"."graphId" IS NULL
)
WHERE EXISTS (
  SELECT 1
  FROM "automationRun"
  WHERE "automationRun"."sessionId" = "session"."id"
    AND "automationRun"."taskId" IS NOT NULL
    AND "automationRun"."graphId" IS NULL
);

CREATE INDEX "session_automationTaskId_idx" ON "session"("automationTaskId");
CREATE INDEX "session_runGraphId_idx" ON "session"("runGraphId");
CREATE UNIQUE INDEX "automationRun_sessionId_key" ON "automationRun"("sessionId");

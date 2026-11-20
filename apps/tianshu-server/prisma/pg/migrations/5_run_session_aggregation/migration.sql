-- PostgreSQL 变体：与 SQLite migration 5 同构，标识符保留 camelCase。
ALTER TABLE "session" ADD COLUMN "automationTaskId" INTEGER;
ALTER TABLE "session" ADD COLUMN "runGraphId" INTEGER;
ALTER TABLE "automationRun" ADD COLUMN "workspaceId" INTEGER;

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

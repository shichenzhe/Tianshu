-- 批7（security P1-3）：审批记忆参数级化（PG 方言——TIMESTAMP(3) 对齐
-- Prisma DateTime 映射）。PG 每 boot migrate deploy 跑增量（存量路径
-- 无需 ensure 补列）。
ALTER TABLE "toolPermission" ADD COLUMN "pattern" TEXT;
ALTER TABLE "toolPermission" ADD COLUMN "lastUsedAt" TIMESTAMP(3);
DROP INDEX IF EXISTS "idx_tool_permission_ws_tool";
CREATE UNIQUE INDEX "idx_tool_permission_ws_tool_pattern" ON "toolPermission"(workspaceId, toolName, pattern);

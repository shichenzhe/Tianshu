-- 批7（security P1-3）：审批记忆参数级化（PG 方言——TIMESTAMP(3) 对齐
-- Prisma DateTime 映射）。PG 每 boot migrate deploy 跑增量（存量路径
-- 无需 ensure 补列）。
ALTER TABLE "toolPermission" ADD COLUMN "pattern" TEXT;
ALTER TABLE "toolPermission" ADD COLUMN "lastUsedAt" TIMESTAMP(3);
DROP INDEX IF EXISTS "idx_tool_permission_ws_tool";
-- 列名必须带引号：PG 无引号标识符折叠小写，与 0_init 带引号建的骆驼列
-- "workspaceId" 不匹配（42703 column does not exist）；SQLite 版同款
-- 无引号写法靠其大小写不敏感才未暴露——PG 主库首启必炸
CREATE UNIQUE INDEX "idx_tool_permission_ws_tool_pattern" ON "toolPermission"("workspaceId", "toolName", "pattern");

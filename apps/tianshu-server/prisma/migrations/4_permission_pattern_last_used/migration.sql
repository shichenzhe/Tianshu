-- 批7（security P1-3）：审批记忆参数级化——toolPermission 加 pattern
-- （参数级记忆：bash 前缀 `git *` / 路径 glob `src/**`，NULL = 整工具旧
-- 全等语义）与 lastUsedAt（命中 fire-and-forget 回写，安全中心「90 天
-- 未用」治理数据源）；唯一索引扩含 pattern（同 pattern 拒重、跨 pattern
-- 共存——NULL 互异由写路径 findFirst+create 幂等兜底）。
-- SQLite 存量升级库快路径不跑迁移，由 ensurePermissionPatternColumns
-- 启动幂等补列 + 重建索引（ensureModelCapabilityColumns 先例）。
ALTER TABLE "toolPermission" ADD COLUMN "pattern" TEXT;
ALTER TABLE "toolPermission" ADD COLUMN "lastUsedAt" DATETIME;
DROP INDEX IF EXISTS "idx_tool_permission_ws_tool";
CREATE UNIQUE INDEX "idx_tool_permission_ws_tool_pattern" ON "toolPermission"(workspaceId, toolName, pattern);

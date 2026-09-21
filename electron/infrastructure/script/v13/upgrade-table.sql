-- /electron/infrastructure/script/v13/upgrade-table.sql
--/p 性能索引：消息按创建时间过滤（记忆整理 fetchRecentConversation 按 createdAt >= 7天前 全量拉取，此前为消息表全表扫描）
--/ignore
CREATE INDEX IF NOT EXISTS message_createdAt_index ON message (createdAt);
--/p 性能索引：会话按工作空间过滤（listSessions 与建会话时的模型继承查询，此前靠 userId 索引兜底后线性过滤）
--/ignore
CREATE INDEX IF NOT EXISTS session_workspaceId_index ON session (workspaceId);

-- /electron/infrastructure/script/v12/upgrade-table.sql
--/p 多用户隔离：AI 服务商归属用户（apiKey 不再跨账号可见）
--/ignore
ALTER TABLE provider ADD COLUMN userId INTEGER NULL;
--/p 多用户隔离：助手归属用户
--/ignore
ALTER TABLE assistant ADD COLUMN userId INTEGER NULL;
--/p 多用户隔离：工作空间归属用户
--/ignore
ALTER TABLE workspace ADD COLUMN userId INTEGER NULL;
--/p 多用户隔离：会话归属用户（冗余列，创建时随工作空间写入）
--/ignore
ALTER TABLE session ADD COLUMN userId INTEGER NULL;
--/p 多用户隔离：MCP 服务器归属用户
--/ignore
ALTER TABLE mcpServer ADD COLUMN userId INTEGER NULL;
--/p 多用户隔离：自动化任务归属用户
--/ignore
ALTER TABLE automationTask ADD COLUMN userId INTEGER NULL;
--/p 多用户隔离：资料库条目归属用户（新建时随根继承）
--/ignore
ALTER TABLE libraryItem ADD COLUMN userId INTEGER NULL;
--/p 多用户隔离：系统选项按用户隔离（type="app" 行保持 NULL = 应用级共享）
--/ignore
ALTER TABLE option ADD COLUMN userId INTEGER NULL;

CREATE INDEX IF NOT EXISTS provider_userId_index ON provider (userId);
CREATE INDEX IF NOT EXISTS assistant_userId_index ON assistant (userId);
CREATE INDEX IF NOT EXISTS workspace_userId_index ON workspace (userId);
CREATE INDEX IF NOT EXISTS session_userId_index ON session (userId);
CREATE INDEX IF NOT EXISTS mcpServer_userId_index ON mcpServer (userId);
CREATE INDEX IF NOT EXISTS automationTask_userId_index ON automationTask (userId);
CREATE INDEX IF NOT EXISTS libraryItem_userId_index ON libraryItem (userId);
CREATE INDEX IF NOT EXISTS option_userId_index ON option (userId);

--/p option 唯一索引扩含 userId（NULL≠NULL：app 级行由 upsert 单写保证一行）
DROP INDEX IF EXISTS idx_option_type_name;
CREATE UNIQUE INDEX IF NOT EXISTS idx_option_type_name_user ON option (type, name, userId);

-- /electron/infrastructure/script/v12/upgrade-data.sql
-- 存量数据归属第一个用户（升级时库中通常已有账号；user 为空时子查询
-- 返回 NULL，SET 无效果，全新库无存量业务行，均安全幂等）
--/p 存量服务商归属第一个用户
UPDATE provider SET userId = (SELECT MIN(id) FROM user) WHERE userId IS NULL;
--/p 存量助手归属第一个用户
UPDATE assistant SET userId = (SELECT MIN(id) FROM user) WHERE userId IS NULL;
--/p 存量工作空间归属第一个用户
UPDATE workspace SET userId = (SELECT MIN(id) FROM user) WHERE userId IS NULL;
--/p 存量会话归属第一个用户
UPDATE session SET userId = (SELECT MIN(id) FROM user) WHERE userId IS NULL;
--/p 存量 MCP 服务器归属第一个用户
UPDATE mcpServer SET userId = (SELECT MIN(id) FROM user) WHERE userId IS NULL;
--/p 存量自动化任务归属第一个用户
UPDATE automationTask SET userId = (SELECT MIN(id) FROM user) WHERE userId IS NULL;
--/p 存量资料库条目归属第一个用户
UPDATE libraryItem SET userId = (SELECT MIN(id) FROM user) WHERE userId IS NULL;
--/p 存量系统选项归属第一个用户（type="app" 为应用级共享，保持 NULL）
UPDATE option SET userId = (SELECT MIN(id) FROM user) WHERE userId IS NULL AND type != 'app';

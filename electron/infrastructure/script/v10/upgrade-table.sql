-- /electron/infrastructure/script/v10/upgrade-table.sql
--/p 新建任务场景（daily|coding|design；null = 旧会话/未指定）
--/ignore
ALTER TABLE session ADD COLUMN scenario TEXT NULL;
--/p 技能场景标签（JSON 数组字符串，如 ["daily","coding"]；null = 未打标）
--/ignore
ALTER TABLE skillRecord ADD COLUMN scenarios TEXT NULL;

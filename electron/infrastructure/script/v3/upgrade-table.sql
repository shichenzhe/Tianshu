--/p 会话加模式列（P3：agent 默认/ask 仅问答/plan 计划）
--/ignore
ALTER TABLE session ADD COLUMN mode TEXT NULL;

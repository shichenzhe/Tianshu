--/p 计划事项 AI 进展摘要（子系统 F：只经 plan_append_summary 工具追加写入，人路径不可编辑）
--/ignore
ALTER TABLE planItem ADD COLUMN aiSummary TEXT NULL;

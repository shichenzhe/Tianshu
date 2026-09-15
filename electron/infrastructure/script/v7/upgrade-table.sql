--/p 自动化任务项目化（子系统 E：projectId NULL = 全局任务；运行会话归属项目并注入项目指令）
--/ignore
ALTER TABLE automationTask ADD COLUMN projectId INTEGER NULL;
--/ignore
CREATE INDEX IF NOT EXISTS automation_task_projectId_index ON automationTask (projectId);

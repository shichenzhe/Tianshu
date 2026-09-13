--/p 计划/任务事项表（项目模块三期：计划 Tab = 项目全量事项，任务 Tab = 个人聚合；projectId NULL = 本地任务）
CREATE TABLE IF NOT EXISTS planItem (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    projectId INTEGER NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'not_started',
    priority TEXT NOT NULL DEFAULT 'P1',
    assigneeId INTEGER NULL,
    tags TEXT NULL,
    customFields TEXT NULL,
    sortOrder INTEGER NOT NULL DEFAULT 0,
    createdById INTEGER NOT NULL,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL
);
--/ignore
CREATE INDEX IF NOT EXISTS plan_item_projectId_index ON planItem (projectId);
--/ignore
CREATE INDEX IF NOT EXISTS plan_item_assignee_index ON planItem (assigneeId);

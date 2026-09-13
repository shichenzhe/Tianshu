--/p 计划事项排期与来源（子系统 A：甘特/日历地基；source = manual|ai|template）
--/ignore
ALTER TABLE planItem ADD COLUMN startDate DATETIME NULL;
--/ignore
ALTER TABLE planItem ADD COLUMN dueDate DATETIME NULL;
--/ignore
ALTER TABLE planItem ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
--/p 计划视图配置表（子系统 A：视图 = 类型 + 筛选/排序/分组配置；name 空串 = 播种的默认视图，UI 按 type 显示本地化名）
CREATE TABLE IF NOT EXISTS planView (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    projectId INTEGER NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'table',
    groupBy TEXT NULL,
    filterJson TEXT NOT NULL DEFAULT '{}',
    sortJson TEXT NOT NULL DEFAULT '[]',
    sortOrder INTEGER NOT NULL DEFAULT 0,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL
);
--/ignore
CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_view_project_name ON planView (projectId, name);
--/ignore
CREATE INDEX IF NOT EXISTS plan_view_projectId_index ON planView (projectId);

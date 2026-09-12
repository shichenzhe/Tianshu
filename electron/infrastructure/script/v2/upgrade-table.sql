--/p 新建项目表（项目模块一期）
CREATE TABLE IF NOT EXISTS project (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    systemPrompt TEXT NULL,
    templateKey TEXT NULL,
    ownerId INTEGER NOT NULL,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL
);
--/ignore
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_owner_name ON project (ownerId, name);

--/p 项目成员表（多人协同预留，一期仅写入创建者为 owner）
CREATE TABLE IF NOT EXISTS projectMember (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    projectId INTEGER NOT NULL,
    userId INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    joinedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--/ignore
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_member_pid_uid ON projectMember (projectId, userId);

--/p 项目能力挂载表（itemType: assistant | skill | mcpServer）
CREATE TABLE IF NOT EXISTS projectBinding (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    projectId INTEGER NOT NULL,
    itemType TEXT NOT NULL,
    itemId INTEGER NOT NULL,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--/ignore
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_binding ON projectBinding (projectId, itemType, itemId);
--/ignore
CREATE INDEX IF NOT EXISTS project_binding_projectId_index ON projectBinding (projectId);

--/p 会话归属项目（项目动态流会话；NULL = 普通会话，出现在 AI 任务树）
--/ignore
ALTER TABLE session ADD COLUMN projectId INTEGER NULL;
--/ignore
CREATE INDEX IF NOT EXISTS session_projectId_index ON session (projectId);

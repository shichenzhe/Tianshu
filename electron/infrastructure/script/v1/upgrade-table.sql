-- /electron/infrastructure/script/v1/upgrade-table.sql
-- 发布前全量建表快照（已并入 v2–v14 的表结构与索引；应用发布后 schema
-- 变更再逐版新增 script/vN 增量脚本，v1 不再回写）

--/p 新建用户表
CREATE TABLE IF NOT EXISTS user (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    email TEXT NULL UNIQUE,
    nickname TEXT NULL
);

--/ignore
CREATE INDEX IF NOT EXISTS user_username_index ON user(username);
--/ignore
CREATE INDEX IF NOT EXISTS idx_user_email ON user (email);

--/p 新建选项表（v12 起按用户隔离；type="app" 行 userId 保持 NULL = 应用级共享）
CREATE TABLE IF NOT EXISTS option (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    note TEXT NULL,
    userId INTEGER NULL
);

--/p 唯一索引含 userId（NULL≠NULL：app 级行由 upsert 单写保证一行）
--/ignore
CREATE UNIQUE INDEX IF NOT EXISTS idx_option_type_name_user ON option (type, name, userId);
--/ignore
CREATE INDEX IF NOT EXISTS option_type_index ON option (type);
--/ignore
CREATE INDEX IF NOT EXISTS option_userId_index ON option (userId);

--/p 新建服务商表（AI 模块）
CREATE TABLE IF NOT EXISTS provider (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    baseUrl TEXT NOT NULL,
    apiKey TEXT NULL,
    extraHeaders TEXT NULL,
    enabled BOOLEAN NOT NULL DEFAULT 1,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL,
    userId INTEGER NULL
);

--/p v12 多用户隔离：服务商归属用户（apiKey 不再跨账号可见）
--/ignore
CREATE INDEX IF NOT EXISTS provider_userId_index ON provider (userId);

--/p 新建模型表（AI 模块）
CREATE TABLE IF NOT EXISTS model (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    providerId INTEGER NOT NULL,
    modelId TEXT NOT NULL,
    name TEXT NULL,
    enabled BOOLEAN NOT NULL DEFAULT 1,
    temperature REAL NULL,
    topP REAL NULL,
    maxTokens INTEGER NULL,
    contextWindow INTEGER NULL,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL
);

--/ignore
CREATE INDEX IF NOT EXISTS model_providerId_index ON model (providerId);

--/p 新建助手预设表（AI 模块）
CREATE TABLE IF NOT EXISTS assistant (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    icon TEXT NULL,
    systemPrompt TEXT NOT NULL,
    temperature REAL NULL,
    topP REAL NULL,
    maxTokens INTEGER NULL,
    builtin BOOLEAN NOT NULL DEFAULT 0,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL,
    userId INTEGER NULL
);

--/p v12 多用户隔离：助手归属用户
--/ignore
CREATE INDEX IF NOT EXISTS assistant_userId_index ON assistant (userId);

--/p 新建工作空间表（AI 模块，directoryPath 为 P1 预留；writeApprovedAt 为 agent 审批授权时间）
CREATE TABLE IF NOT EXISTS workspace (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    icon TEXT NULL,
    directoryPath TEXT NULL,
    defaultModelId INTEGER NULL,
    writeApprovedAt DATETIME NULL,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL,
    userId INTEGER NULL
);

--/p v12 多用户隔离：工作空间归属用户
--/ignore
CREATE INDEX IF NOT EXISTS workspace_userId_index ON workspace (userId);

--/p 新建会话表（AI 模块；mode 为 agent 默认/ask 仅问答/plan 计划；pinnedAt/archivedAt 置顶归档；summary/compactedUpToId 会话压缩）
CREATE TABLE IF NOT EXISTS session (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspaceId INTEGER NOT NULL,
    assistantId INTEGER NULL,
    currentModelId INTEGER NULL,
    title TEXT NOT NULL DEFAULT '新会话',
    mode TEXT NULL,
    pinnedAt DATETIME,
    archivedAt DATETIME,
    summary TEXT NULL,
    compactedUpToId INTEGER NULL,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL,
    lastMessageAt DATETIME NULL,
    userId INTEGER NULL
);

--/p v12 多用户隔离：会话归属用户（冗余列，创建时随工作空间写入）
--/ignore
CREATE INDEX IF NOT EXISTS session_userId_index ON session (userId);
--/p v13 性能索引：会话按工作空间过滤（listSessions 与模型继承查询）
--/ignore
CREATE INDEX IF NOT EXISTS session_workspaceId_index ON session (workspaceId);

--/p 新建消息表（AI 模块，blocks 为 JSON 数组文本；durationMs 为 assistant 生成耗时）
CREATE TABLE IF NOT EXISTS message (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sessionId INTEGER NOT NULL,
    role TEXT NOT NULL,
    blocks TEXT NOT NULL,
    modelId INTEGER NULL,
    assistantId INTEGER NULL,
    error TEXT NULL,
    durationMs INTEGER NULL,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

--/ignore
CREATE INDEX IF NOT EXISTS message_sessionId_index ON message (sessionId);
--/p v13 性能索引：消息按创建时间过滤（记忆整理 fetchRecentConversation 全量拉取，此前为全表扫描）
--/ignore
CREATE INDEX IF NOT EXISTS message_createdAt_index ON message (createdAt);

--/p 新建 MCP 服务表（P2 消费，AI 模块）
CREATE TABLE IF NOT EXISTS mcpServer (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    transport TEXT NOT NULL,
    command TEXT NULL,
    args TEXT NULL,
    env TEXT NULL,
    url TEXT NULL,
    headers TEXT NULL,
    enabled BOOLEAN NOT NULL DEFAULT 1,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL,
    userId INTEGER NULL
);

--/p v12 多用户隔离：MCP 服务器归属用户
--/ignore
CREATE INDEX IF NOT EXISTS mcpServer_userId_index ON mcpServer (userId);

--/p 新建工具审批记忆表（工作空间级 allowed-tools，参照 Claude Code）
CREATE TABLE IF NOT EXISTS toolPermission (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspaceId INTEGER NOT NULL,
    toolName TEXT NOT NULL,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

--/ignore
CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_permission_ws_tool ON toolPermission (workspaceId, toolName);

--/p 新建技能安装记录表（P-A 技能管理：目录为文件源、DB 为状态源，自愈对账）
CREATE TABLE IF NOT EXISTS skillRecord (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    slug TEXT NULL,
    version TEXT NULL,
    source TEXT NOT NULL,
    dir TEXT NOT NULL,
    description TEXT NULL,
    enabled BOOLEAN NOT NULL DEFAULT 1,
    installedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL
);

--/p 新建技能埋点事件表（P-E 技能埋点：事件流算频率/时序/活跃度；批量操作逐技能记 batch_*）
CREATE TABLE IF NOT EXISTS skillStat (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    event TEXT NOT NULL,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

--/p 自动化模块：定时任务表
CREATE TABLE IF NOT EXISTS automationTask (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    workspaceId INTEGER NOT NULL,
    modelId INTEGER NOT NULL,
    temperature REAL,
    scheduleJson TEXT NOT NULL,
    scheduleText TEXT NOT NULL,
    startAt DATETIME,
    endAt DATETIME,
    missedPolicy TEXT NOT NULL DEFAULT 'skip',
    accessMode TEXT NOT NULL DEFAULT 'default',
    enabled BOOLEAN NOT NULL DEFAULT true,
    status TEXT NOT NULL DEFAULT 'active',
    statusNote TEXT,
    lastRunAt DATETIME,
    nextRunAt DATETIME,
    templateSlug TEXT,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL,
    userId INTEGER NULL
);

--/ignore
CREATE INDEX IF NOT EXISTS automationTask_enabled_idx ON automationTask(enabled);
--/p v12 多用户隔离：自动化任务归属用户
--/ignore
CREATE INDEX IF NOT EXISTS automationTask_userId_index ON automationTask (userId);

--/p 自动化模块：运行记录表
CREATE TABLE IF NOT EXISTS automationRun (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    taskId INTEGER NOT NULL,
    sessionId INTEGER,
    attempt INTEGER NOT NULL DEFAULT 1,
    triggerType TEXT NOT NULL,
    status TEXT NOT NULL,
    durationMs INTEGER,
    promptTokens INTEGER,
    completionTokens INTEGER,
    error TEXT,
    startedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finishedAt DATETIME
);

--/ignore
CREATE INDEX IF NOT EXISTS automationRun_taskId_idx ON automationRun(taskId);
--/ignore
CREATE INDEX IF NOT EXISTS automationRun_startedAt_idx ON automationRun(startedAt);

--/p 自动化模块：埋点事件表（事件流，无唯一约束，同 skillStat）
CREATE TABLE IF NOT EXISTS automationStat (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    event TEXT NOT NULL,
    detail TEXT NOT NULL,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

--/p 新建资料库条目表（v11 起：文件夹/文件元数据，文件内容存 {userData}/library/{id}/ 下；v12 userId 归属；v14 favorite 收藏/♥、lastViewedAt 最近访问排序与 NEW 判定，folder 恒 NULL）
CREATE TABLE IF NOT EXISTS libraryItem (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    parentId INTEGER,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    fileType TEXT,
    mimeType TEXT,
    size INTEGER,
    originalPath TEXT,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL,
    userId INTEGER NULL,
    favorite BOOLEAN NOT NULL DEFAULT 0,
    lastViewedAt DATETIME
);

--/ignore
CREATE INDEX IF NOT EXISTS libraryItem_parentId_index ON libraryItem (parentId);
--/ignore
CREATE INDEX IF NOT EXISTS libraryItem_userId_index ON libraryItem (userId);

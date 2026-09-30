-- /electron/infrastructure/script/v1/upgrade-table.sql
-- 发布前全量建表脚本（已并入 v2–v14 的全部表结构与索引变更；应用发布后
-- schema 变更再逐版新增 script/vN 增量脚本，v1 不再回写）

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
    description TEXT NULL,
    tags TEXT NULL,
    sourceSlug TEXT NULL,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL,
    userId INTEGER NULL
);

--/p 专家市场：描述/标签(JSON数组字符串)/市场来源slug

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
    projectId INTEGER NULL,
    userId INTEGER NULL
);

--/p v12 多用户隔离：工作空间归属用户
--/ignore
CREATE INDEX IF NOT EXISTS workspace_userId_index ON workspace (userId);
--/p v3 资产空间关联：项目专属 workspace 的 projectId（NULL = 普通空间）
--/ignore
CREATE INDEX IF NOT EXISTS workspace_projectId_index ON workspace (projectId);

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
    projectId INTEGER NULL,
    planItemId INTEGER NULL,
    scenario TEXT NULL,
    userId INTEGER NULL
);

--/p v12 多用户隔离：会话归属用户（冗余列，创建时随工作空间写入）
--/ignore
CREATE INDEX IF NOT EXISTS session_userId_index ON session (userId);
--/p v2 会话归属项目（项目动态流会话；NULL = 普通会话，出现在 AI 任务树）
--/ignore
CREATE INDEX IF NOT EXISTS session_projectId_index ON session (projectId);
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

--/p 新建技能安装记录表（P-A 技能管理：目录为文件源、DB 为状态源，自愈对账；scenarios 为场景标签 JSON 数组，如 ["daily","coding"]，null = 未打标）
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
    updatedAt DATETIME NOT NULL,
    scenarios TEXT NULL
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
    projectId INTEGER NULL,
    userId INTEGER NULL
);

--/ignore
CREATE INDEX IF NOT EXISTS automationTask_enabled_idx ON automationTask(enabled);
--/p v12 多用户隔离：自动化任务归属用户
--/ignore
CREATE INDEX IF NOT EXISTS automationTask_userId_index ON automationTask (userId);
--/p v7 自动化任务项目化（projectId NULL = 全局任务；运行会话归属项目并注入项目指令）
--/ignore
CREATE INDEX IF NOT EXISTS automation_task_projectId_index ON automationTask (projectId);

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
    url TEXT,
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

--/p 新建产物收藏表（本地产物「我的收藏」；产物无 DB 实体，键 workspaceId+relPath 与文件生命周期解耦，userId 仅记录归属）
CREATE TABLE IF NOT EXISTS artifactFavorite (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    workspaceId INTEGER NOT NULL,
    relPath TEXT NOT NULL,
    userId INTEGER NULL,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

--/ignore
CREATE UNIQUE INDEX IF NOT EXISTS artifactFavorite_workspaceId_relPath_key ON artifactFavorite (workspaceId, relPath);
--/ignore
CREATE INDEX IF NOT EXISTS artifactFavorite_userId_index ON artifactFavorite (userId);

--/p 新建项目表（项目模块一期；ownerId + name 唯一）
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

--/p 计划/任务事项表（项目模块三期+排期/描述/AI 摘要；projectId NULL = 本地任务；source = manual|ai|template；aiSummary 只经 plan_append_summary 工具追加写入）
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
    updatedAt DATETIME NOT NULL,
    startDate DATETIME NULL,
    dueDate DATETIME NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    description TEXT NULL,
    aiSummary TEXT NULL
);
--/ignore
CREATE INDEX IF NOT EXISTS plan_item_projectId_index ON planItem (projectId);
--/ignore
CREATE INDEX IF NOT EXISTS plan_item_assignee_index ON planItem (assigneeId);

--/p 计划视图配置表（视图 = 类型 + 筛选/排序/分组配置；name 空串 = 播种的默认视图，部分唯一索引豁免空名）
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
--/p 存量库曾建过全列唯一索引，重放时替换为部分索引（空名播种豁免）
--/ignore
DROP INDEX IF EXISTS idx_plan_view_project_name;
--/ignore
CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_view_project_name ON planView (projectId, name) WHERE name != '';
--/ignore
CREATE INDEX IF NOT EXISTS plan_view_projectId_index ON planView (projectId);

--/p 计划事项附件关联表（文件实体在项目资产空间 attachments/ 子目录，删事项级联删关联保留文件）
CREATE TABLE IF NOT EXISTS planItemAttachment (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    planItemId INTEGER NOT NULL,
    fileName TEXT NOT NULL,
    assetPath TEXT NOT NULL,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--/ignore
CREATE INDEX IF NOT EXISTS plan_item_attachment_planItemId_index ON planItemAttachment (planItemId);

--/p 安全审计日志表（安全中心 SP1）：哈希链防篡改，sequence 唯一标识链序
CREATE TABLE IF NOT EXISTS securityAuditLog (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sequence INTEGER NOT NULL,
    category TEXT NOT NULL,
    eventType TEXT NOT NULL,
    decision TEXT NOT NULL,
    detail TEXT,
    commandPreview TEXT,
    commandHash TEXT,
    sessionId INTEGER,
    prevHash TEXT,
    hash TEXT NOT NULL,
    createdAt DATETIME NOT NULL DEFAULT (datetime('now'))
);
--/ignore
CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_sequence ON securityAuditLog (sequence);
--/ignore
CREATE INDEX IF NOT EXISTS idx_audit_createdAt ON securityAuditLog (createdAt);
--/ignore
CREATE INDEX IF NOT EXISTS idx_audit_category ON securityAuditLog (category);

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

--/p 新建选项表
CREATE TABLE IF NOT EXISTS option (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    note TEXT NULL
);

--/ignore
CREATE UNIQUE INDEX IF NOT EXISTS idx_option_type_name ON option (type, name);
--/ignore
CREATE INDEX IF NOT EXISTS option_type_index ON option (type);

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
    updatedAt DATETIME NOT NULL
);

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
    updatedAt DATETIME NOT NULL
);

--/p 新建工作空间表（AI 模块，directoryPath 为 P1 预留）
CREATE TABLE IF NOT EXISTS workspace (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    icon TEXT NULL,
    directoryPath TEXT NULL,
    defaultModelId INTEGER NULL,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL
);

--/p 新建会话表（AI 模块）
CREATE TABLE IF NOT EXISTS session (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspaceId INTEGER NOT NULL,
    assistantId INTEGER NULL,
    currentModelId INTEGER NULL,
    title TEXT NOT NULL DEFAULT '新会话',
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL,
    lastMessageAt DATETIME NULL
);

--/p 新建消息表（AI 模块，blocks 为 JSON 数组文本）
CREATE TABLE IF NOT EXISTS message (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sessionId INTEGER NOT NULL,
    role TEXT NOT NULL,
    blocks TEXT NOT NULL,
    modelId INTEGER NULL,
    assistantId INTEGER NULL,
    error TEXT NULL,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

--/ignore
CREATE INDEX IF NOT EXISTS message_sessionId_index ON message (sessionId);

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
    updatedAt DATETIME NOT NULL
);

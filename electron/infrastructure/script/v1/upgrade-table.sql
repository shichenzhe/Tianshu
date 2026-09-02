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

--/p 新建AI模型配置表（可选模块，不需要可删除此表与 modelConfig 相关代码）
CREATE TABLE IF NOT EXISTS modelConfig (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    apiKey TEXT NOT NULL,
    modelName TEXT NOT NULL,
    baseUrl TEXT NOT NULL,
    maxTokens INTEGER NULL,
    temperature REAL NULL,
    isActive BOOLEAN NOT NULL DEFAULT 0,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_model_config_is_active ON modelConfig (isActive);

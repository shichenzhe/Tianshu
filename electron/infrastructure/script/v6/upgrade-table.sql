--/p 新建技能安装记录表(P-A 技能管理:目录为文件源、DB 为状态源,自愈对账)
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

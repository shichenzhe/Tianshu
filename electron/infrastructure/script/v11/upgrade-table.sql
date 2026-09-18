-- /electron/infrastructure/script/v11/upgrade-table.sql
--/p 资料库条目表（文件夹/文件元数据；文件内容存 {userData}/library/{id}/ 下）
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
  updatedAt DATETIME NOT NULL
);
CREATE INDEX IF NOT EXISTS libraryItem_parentId_index ON libraryItem (parentId);

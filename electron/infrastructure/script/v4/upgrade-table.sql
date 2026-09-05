--/p 新建工具审批记忆表（P4 反馈：工作空间级 allowed-tools，参照 Claude Code）
CREATE TABLE IF NOT EXISTS toolPermission (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspaceId INTEGER NOT NULL,
    toolName TEXT NOT NULL,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

--/ignore
CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_permission_ws_tool ON toolPermission (workspaceId, toolName);

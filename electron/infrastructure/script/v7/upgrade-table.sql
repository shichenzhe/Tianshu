--/p 新建技能埋点事件表(P-E 技能埋点:事件流算频率/时序/活跃度;批量操作逐技能记 batch_*)
CREATE TABLE IF NOT EXISTS skillStat (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    event TEXT NOT NULL,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

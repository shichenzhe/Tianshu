--/p 自动化模块(v10):定时任务表
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
  enabled BOOLEAN NOT NULL DEFAULT true,
  status TEXT NOT NULL DEFAULT 'active',
  statusNote TEXT,
  lastRunAt DATETIME,
  nextRunAt DATETIME,
  templateSlug TEXT,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL
);
CREATE INDEX IF NOT EXISTS automationTask_enabled_idx ON automationTask(enabled);

--/p 自动化模块(v10):运行记录表
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
CREATE INDEX IF NOT EXISTS automationRun_taskId_idx ON automationRun(taskId);
CREATE INDEX IF NOT EXISTS automationRun_startedAt_idx ON automationRun(startedAt);

--/p 自动化模块(v10):埋点事件表(事件流,无唯一约束,同 skillStat)
CREATE TABLE IF NOT EXISTS automationStat (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  event TEXT NOT NULL,
  detail TEXT NOT NULL,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

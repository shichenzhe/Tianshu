--/p 安全审计日志表（安全中心 SP1）：哈希链防篡改，sequence 唯一标识链序
CREATE TABLE securityAuditLog (
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
CREATE UNIQUE INDEX idx_audit_sequence ON securityAuditLog (sequence);
CREATE INDEX idx_audit_createdAt ON securityAuditLog (createdAt);
CREATE INDEX idx_audit_category ON securityAuditLog (category);

--/p 工作空间加写入授权时间（P1 agent 审批）
--/ignore
ALTER TABLE workspace ADD COLUMN writeApprovedAt DATETIME NULL;

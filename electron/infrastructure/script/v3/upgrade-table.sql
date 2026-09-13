--/p 资产空间关联（项目模块二期：项目专属 workspace 的 projectId；NULL = 普通空间）
--/ignore
ALTER TABLE workspace ADD COLUMN projectId INTEGER NULL;
--/ignore
CREATE INDEX IF NOT EXISTS workspace_projectId_index ON workspace (projectId);

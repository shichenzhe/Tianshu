--/p 计划事项描述（子系统 D：Markdown 原文，弹窗内编辑/预览）
--/ignore
ALTER TABLE planItem ADD COLUMN description TEXT NULL;
--/p 计划事项附件关联表（子系统 D：文件实体在项目资产空间 attachments/ 子目录，删事项级联删关联保留文件）
CREATE TABLE IF NOT EXISTS planItemAttachment (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    planItemId INTEGER NOT NULL,
    fileName TEXT NOT NULL,
    assetPath TEXT NOT NULL,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--/ignore
CREATE INDEX IF NOT EXISTS plan_item_attachment_planItemId_index ON planItemAttachment (planItemId);

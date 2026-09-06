--/p 消息生成耗时(v9):assistant 生成时长,已完成态展示用
ALTER TABLE message ADD COLUMN durationMs INTEGER NULL;

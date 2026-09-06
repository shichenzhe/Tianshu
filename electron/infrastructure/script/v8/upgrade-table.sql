--/p 会话压缩(/compact):上下文摘要与压缩覆盖点(P6 引用优化)
ALTER TABLE session ADD COLUMN summary TEXT NULL;

--/ignore
ALTER TABLE session ADD COLUMN compactedUpToId INTEGER NULL;

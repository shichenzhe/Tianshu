-- 批1C 改进项 3：图运行落执行时 graphJson 快照（可空、免索引——按 run 行读取；
-- SQLite 存量升级库快路径不跑迁移，由 ensureAutomationRunGraphSnapshotColumn 启动幂等补列）
ALTER TABLE "automationRun" ADD COLUMN "graphJsonSnapshot" TEXT;

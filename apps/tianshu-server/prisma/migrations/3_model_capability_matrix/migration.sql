-- 批5（provider-model §6 项 5）：模型能力矩阵——capabilities JSON /
-- 输入输出单价（USD 每 1M token）/ 备选模型引用（可空、免索引）。
-- SQLite 存量升级库快路径不跑迁移，由 ensureModelCapabilityColumns
-- 启动幂等补列（graphJsonSnapshot/catchUpLimit 先例）。
ALTER TABLE "model" ADD COLUMN "capabilities" TEXT;
ALTER TABLE "model" ADD COLUMN "priceInPerMTokens" REAL;
ALTER TABLE "model" ADD COLUMN "priceOutPerMTokens" REAL;
ALTER TABLE "model" ADD COLUMN "fallbackModelId" INTEGER;

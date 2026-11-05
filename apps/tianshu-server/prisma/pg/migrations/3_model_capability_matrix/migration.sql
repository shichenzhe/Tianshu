-- 批5（provider-model §6 项 5）：模型能力矩阵——capabilities JSON /
-- 输入输出单价（USD 每 1M token）/ 备选模型引用（可空、免索引）。
-- PG 每 boot migrate deploy 跑增量（存量路径无需 ensure 补列）。
ALTER TABLE "model" ADD COLUMN "capabilities" TEXT;
ALTER TABLE "model" ADD COLUMN "priceInPerMTokens" DOUBLE PRECISION;
ALTER TABLE "model" ADD COLUMN "priceOutPerMTokens" DOUBLE PRECISION;
ALTER TABLE "model" ADD COLUMN "fallbackModelId" INTEGER;

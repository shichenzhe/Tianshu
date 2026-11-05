-- 批3A：自动化任务错过补跑上限（missedPolicy=catchUpOnce 时生效，缺省 1=既有只补一次）
ALTER TABLE "automationTask" ADD COLUMN "catchUpLimit" INTEGER NOT NULL DEFAULT 1;

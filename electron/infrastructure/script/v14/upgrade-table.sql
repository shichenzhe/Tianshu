-- /electron/infrastructure/script/v14/upgrade-table.sql
--/p 资料库收藏与最近访问（布局交互 PRD）：favorite（收藏 Tab 与 ♥ 切换）、lastViewedAt（「最近」入口排序 / NEW 判定 / 命令面板最近浏览，folder 恒 NULL）
--/ignore
ALTER TABLE libraryItem ADD COLUMN favorite BOOLEAN NOT NULL DEFAULT 0;
--/p 资料库最近访问时间（布局交互 PRD）：lastViewedAt（「最近」入口排序 / NEW 判定 / 命令面板最近浏览，folder 恒 NULL）
--/ignore
ALTER TABLE libraryItem ADD COLUMN "lastViewedAt" DATETIME;

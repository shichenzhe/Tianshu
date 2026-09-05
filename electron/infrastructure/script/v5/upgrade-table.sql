--/ignore
ALTER TABLE session ADD COLUMN pinnedAt DATETIME;

--/ignore
ALTER TABLE session ADD COLUMN archivedAt DATETIME;

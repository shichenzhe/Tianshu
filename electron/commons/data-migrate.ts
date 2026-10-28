/**
 * 历史数据一次性迁移（数据目录迁往 ~/.tianshu 时使用）：旧位置整体冷
 * 拷贝到新目录，避免存量安装升级后数据"丢失"。复制而非移动——旧目录
 * 留作回退备份；目标已有内容或旧位置不存在时跳过拷贝（幂等）。失败
 * 仅记日志不抛出：按「开发期数据可弃」语义降级为全新数据，不阻塞启动。
 */
import fs from "node:fs";
import path from "node:path";

/**
 * 目录迁移：目标无内容且旧目录存在时递归冷拷贝（WAL 伴生文件等由整
 * 目录拷贝天然覆盖）；无论如何确保目标目录存在（消费者可直接落盘）。
 */
export function migrateLegacyDir(targetDir: string, legacyDir: string): void {
  try {
    if (fs.existsSync(legacyDir)) {
      const targetHasData =
        fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0;
      if (!targetHasData) {
        fs.cpSync(legacyDir, targetDir, { recursive: true });
        console.info("已迁移历史数据目录:", legacyDir, "->", targetDir);
        return;
      }
    }
    fs.mkdirSync(targetDir, { recursive: true });
  } catch (e) {
    console.error("历史数据目录迁移失败，将使用全新目录:", e);
  }
}

/** 文件迁移（如 .jwt-secret）：目标不存在且旧文件存在时拷贝并还原权限 */
export function migrateLegacyFile(
  targetPath: string,
  legacyPath: string,
): void {
  try {
    if (fs.existsSync(targetPath) || !fs.existsSync(legacyPath)) return;
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(legacyPath, targetPath);
    fs.chmodSync(targetPath, 0o600); // copyFileSync 默认 666，密钥文件须还原 600
    console.info("已迁移历史数据文件:", legacyPath, "->", targetPath);
  } catch (e) {
    console.error("历史数据文件迁移失败:", e);
  }
}

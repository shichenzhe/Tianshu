import prisma from "../../commons/prisma-client";
export default class VersionRepository {
  // 初始化数据库版本表
  static async initTable(): Promise<void> {
    const createVersionTableQuery = `
      CREATE TABLE IF NOT EXISTS db_version (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version INTEGER NOT NULL
      );
    `;
    const result = await prisma.$executeRawUnsafe(createVersionTableQuery);
    console.info("create version table success", result);
  }

  // 获取当前数据库版本
  static async getCurrent(): Promise<number> {
    try {
      const result = await prisma.db_version.findFirst({
        orderBy: {
          id: "desc",
        },
        select: {
          version: true,
        },
      });
      return result?.version ?? 0;
      // const selectVersionQuery = `SELECT version FROM db_version ORDER BY id DESC LIMIT 1;`;
      // const stmt = db.prepare(selectVersionQuery);
      // const result = stmt.get();
      // return result ? result.version : 0;
    } catch (e) {
      console.info(e);
      return 0;
    }
  }

  // 检查并更新数据库版本
  static async update(
    currentVersion: number,
    targetVersion: number,
  ): Promise<void> {
    console.info(
      `Updating database from db_version ${currentVersion} to ${targetVersion}`,
    );

    if (currentVersion === targetVersion) {
      return;
    }

    // 更新数据库版本记录
    await prisma.db_version.create({
      data: {
        version: targetVersion,
      },
    });
    console.info(`Database updated to version ${targetVersion}`);
  }
}

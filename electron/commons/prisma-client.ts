import fs from "node:fs";
import path from "node:path";
import { app } from "electron"; // 用于 Electron 应用的全局功能
import { PrismaClient } from "../generated/prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
// 副作用导入：statement 缓存补丁须在 adapter 创建 Database 实例前生效
// （Node 24 代运行时 Statement GC finalizer 竞态崩溃，详见补丁文件头注释）
import "./sqlite-stmt-cache";

// 判断当前环境是否是开发环境
const isDevelopment = !app.isPackaged;
let databasePath = path.join(app.getPath("userData"), "database");
if (isDevelopment) {
  databasePath = path.join(app.getAppPath(), "database");
}

if (!fs.existsSync(databasePath)) {
  fs.mkdirSync(databasePath, { recursive: true });
}

const dbFilePath = path.join(databasePath, "local.db").replace(/\\/g, "/");
process.env.DATABASE_URL = `file:${dbFilePath}`;
console.info("db version:", process.env.DATABASE_URL);

const adapter = new PrismaBetterSqlite3({ url: dbFilePath });
const prisma = new PrismaClient({
  adapter,
  log: ["info", "warn", "error"], // 输出日志到控制台,方便调试
});

export default prisma;

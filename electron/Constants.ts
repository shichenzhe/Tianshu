export class Constants {
  // 日志保留天数
  static readonly LOG_KEEP_DAYS: string = "7d";
  static readonly LOG_MAX_SIZE: string = "20m";
  // 升级地址（由 scripts/init.mjs 写入；留空则禁用自动更新）
  static readonly UPGRADE_URL: string = "";
  // 数据库版本（新增升级脚本时 +1，并在 script/ 下建 vN 目录）
  static readonly DATABASE_VERSION: number = 4;
}

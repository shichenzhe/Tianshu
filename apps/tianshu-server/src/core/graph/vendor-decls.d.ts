/**
 * 未安装的懒加载驱动声明（GA-T4 备案）：
 *
 * graph 节点族的第三方驱动（邮件/表格/数据库/文档解析九件）未列入本计划
 * server 依赖面（spec §3.3 摘表清单外的运行时周边；镜像端由 Electron 打包
 * 供给）。executor/db-client/doc-extract 副本对它们全部为**懒加载**动态
 * import——本声明仅保住编译期类型解析，运行时未装驱动时对应节点类型以
 * 可读错误落节点失败（db 引擎族经 db-client wrapDbError 归一；email/
 * excel/docExtract 经 toNodeFailure 归类），不影响其余节点与 run 状态机。
 * 后续如需在 server 启用这些节点，npm 安装对应驱动并删除本声明即可
 * （零源码改动）。
 */
declare module 'nodemailer';
declare module 'exceljs';
declare module 'better-sqlite3' {
  const Database: any;
  namespace Database {
    type Database = any;
    type Statement = any;
  }
  export default Database;
}
declare module 'pg';
declare module 'mysql2/promise';
declare module 'mysql2';
declare module 'oracledb';
declare module 'mssql';
declare module 'pdf-parse';
declare module 'mammoth';

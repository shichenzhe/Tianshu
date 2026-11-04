/**
 * ~/.tianshu 数据根统一装配：各数据目录确保存在 + 自旧位置一次性冷拷贝
 * 迁移（幂等，语义见 data-migrate.ts）。Electron 自身的运行时数据
 * （Cache/Local Storage 等）留在 userData，不随业务数据迁移。
 * 自定义数据根（data-root.json，设置面板写入）：先做可写防护（网络卷/
 * 只读卷回退默认根，仅本次启动），再从默认根整分组冷拷贝到新根——
 * 此时无任何数据库连接打开，SQLite 冷迁移安全。
 *
 * 执行时序（关键）：rolldown 打包会把本模块内联进 main.js 主体，而
 * prisma-client/Log 成为被 import 的独立 chunk 先于 main 主体初始化——
 * 「main.ts 首位副作用 import」不可依赖。改为顺序敏感的消费者
 * （prisma-client 建库、Log 落日志）各自在首次使用前调用本函数；幂等
 * 由 done flag 保证，多入口调用无害。
 */
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import {
  defaultTianshuRoot,
  appDataHome,
  databaseDir,
  skillsDir,
  libraryDir,
  logsDir,
  attachmentsDir,
  workflowAssetsDir,
  projectsDir,
  fileHistoryDir,
  jwtSecretPath,
} from "./paths";
import {
  readConfiguredDataRoot,
  suppressConfiguredDataRoot,
} from "./data-root-config";
import { migrateLegacyDir, migrateLegacyFile } from "./data-migrate";

/** 自定义根生效前置防护：不可写（网络卷/权限）时抑制配置并回退默认根 */
function ensureCustomRootWritable(): void {
  const configured = readConfiguredDataRoot();
  if (!configured) return;
  try {
    fs.mkdirSync(configured, { recursive: true });
    fs.accessSync(configured, fs.constants.W_OK);
  } catch (e) {
    console.error("自定义数据根不可写，本次启动回退默认根:", e);
    suppressConfiguredDataRoot();
  }
}

/** 幂等闸：多消费者各自先调，实际装配仅首个调用执行 */
let ensured = false;

export function ensureTianshuData(): void {
  if (ensured) return;
  ensured = true;
  ensureCustomRootWritable();
  const defaultRoot = defaultTianshuRoot();
  // 自定义根（与默认根不同）：从默认根整分组冷拷贝——新根非空时幂等
  // 跳过（用户可能故意指向已有数据）；默认根数据保留作回退备份
  const configured = readConfiguredDataRoot();
  if (configured && configured !== defaultRoot) {
    migrateLegacyDir(
      appDataHome(),
      path.join(defaultRoot, app.isPackaged ? "app" : "dev"),
    );
  }
  const legacyRoot = app.getPath("userData");
  const dirs = [
    databaseDir(),
    skillsDir(),
    libraryDir(),
    logsDir(),
    attachmentsDir(),
    workflowAssetsDir(),
    projectsDir(),
    fileHistoryDir(),
  ];
  for (const dir of dirs) {
    migrateLegacyDir(dir, path.join(legacyRoot, path.basename(dir)));
  }
  // database 开发期旧位置在项目根（与生产 userData 不同源），补迁一次
  if (!app.isPackaged) {
    migrateLegacyDir(databaseDir(), path.join(app.getAppPath(), "database"));
  }
  migrateLegacyFile(jwtSecretPath(), path.join(legacyRoot, ".jwt-secret"));
}

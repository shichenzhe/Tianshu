/**
 * 自定义数据根配置（库外存储）：数据根位置由它决定，而数据库又在数据
 * 根内（鸡生蛋），故配置必须落两者之外——Electron userData 下小 json。
 * 修改后重启生效：启动期 tianshu-data 在打开任何数据库连接前完成冷
 * 迁移（SQLite 运行中不可搬，冷态随意）。读不缓存——调用频率低，且免
 * 去写后失效时序问题；坏 json 视为未配置（回退默认根，可恢复）。
 */
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

const CONFIG_FILE = "data-root.json";

/** 本次启动抑制自定义根（不可写等启动期防护触发，回退默认根） */
let suppressed = false;

export function suppressConfiguredDataRoot(): void {
  suppressed = true;
}

/** 归一化：normalize + 去尾分隔符（posix normalize 保留单个尾 /） */
function normalizeRoot(value: string): string {
  return path.normalize(value).replace(/[/\\]+$/, "");
}

/** 读取配置的数据根绝对路径；未配置/坏配置/被抑制返回 null */
export function readConfiguredDataRoot(): string | null {
  if (suppressed) return null;
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(app.getPath("userData"), CONFIG_FILE), "utf8"),
    ) as { dataRoot?: unknown };
    return typeof raw.dataRoot === "string" && path.isAbsolute(raw.dataRoot)
      ? normalizeRoot(raw.dataRoot)
      : null;
  } catch {
    return null;
  }
}

/**
 * 写入/清除配置（null 删除恢复默认）。非绝对路径抛错——自定义根必须
 * 是显式绝对路径，避免随 cwd 漂移。
 */
export function writeConfiguredDataRoot(value: string | null): void {
  const file = path.join(app.getPath("userData"), CONFIG_FILE);
  if (value === null) {
    fs.rmSync(file, { force: true });
    return;
  }
  if (!path.isAbsolute(value)) {
    throw new Error("DATA_ROOT_MUST_BE_ABSOLUTE");
  }
  // userData 常态已存在，mkdir 仅为异常环境（测试/便携模式）兜底
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ dataRoot: normalizeRoot(value) }, null, 2),
  );
}

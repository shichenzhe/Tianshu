/**
 * paths 单测：数据根解析（跨平台形态、app/dev 分组、各具名子目录）。
 * paths 依赖 electron app.isPackaged，经 vi.mock 注入可变 getter 切换
 * dev/prod 分组（仓库既有 electron mock 先例）。
 */
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const packaged = vi.hoisted(() => ({ value: false }));
vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return packaged.value;
    },
  },
}));

import {
  tianshuRoot,
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
} from "../../electron/commons/paths";

describe("tianshuRoot / appDataHome", () => {
  it("数据根为 home 下 .tianshu，env 覆盖优先（全局 setup 已设隔离根）", () => {
    expect(tianshuRoot()).toBe(process.env.TIANSHU_DATA_ROOT);
    expect(tianshuRoot()).not.toBe(path.join(os.homedir(), ".tianshu"));
  });

  it("开发与生产分组分流且都在数据根之下", () => {
    packaged.value = false;
    expect(appDataHome()).toBe(path.join(tianshuRoot(), "dev"));
    packaged.value = true;
    expect(appDataHome()).toBe(path.join(tianshuRoot(), "app"));
  });
});

describe("具名数据目录", () => {
  it("各目录落在对应分组下且子目录名正确", () => {
    packaged.value = true;
    expect(databaseDir()).toBe(path.join(appDataHome(), "database"));
    expect(skillsDir()).toBe(path.join(appDataHome(), "skills"));
    expect(libraryDir()).toBe(path.join(appDataHome(), "library"));
    expect(logsDir()).toBe(path.join(appDataHome(), "logs"));
    expect(attachmentsDir()).toBe(path.join(appDataHome(), "attachments"));
    expect(workflowAssetsDir()).toBe(
      path.join(appDataHome(), "workflow-assets"),
    );
    expect(projectsDir()).toBe(path.join(appDataHome(), "projects"));
    expect(fileHistoryDir()).toBe(path.join(appDataHome(), "file-history"));
    expect(jwtSecretPath()).toBe(path.join(appDataHome(), ".jwt-secret"));
  });

  it("开发分组下同名解析（防硬编码生产路径）", () => {
    packaged.value = false;
    expect(databaseDir()).toBe(path.join(tianshuRoot(), "dev", "database"));
    expect(skillsDir()).toBe(path.join(tianshuRoot(), "dev", "skills"));
  });
});

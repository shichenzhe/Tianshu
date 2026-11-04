/**
 * data-root-config 单测：配置写读往返（normalize）、null 清除、相对
 * 路径写入拒绝、坏 json 读容错回退 null、suppress 抑制（启动期防护）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const dirRef = vi.hoisted(() => ({ dir: "" }));
vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => dirRef.dir) },
}));

import {
  readConfiguredDataRoot,
  writeConfiguredDataRoot,
  suppressConfiguredDataRoot,
} from "../../electron/commons/data-root-config";

let base: string;

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-data-root-cfg-"));
  dirRef.dir = base;
});
afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("data-root-config", () => {
  it("未配置/坏 json 读取返回 null", () => {
    expect(readConfiguredDataRoot()).toBeNull();
    fs.writeFileSync(path.join(base, "data-root.json"), "{broken");
    expect(readConfiguredDataRoot()).toBeNull();
  });

  it("写入绝对路径可读回（normalize 收敛尾分隔符）", () => {
    writeConfiguredDataRoot("/Volumes/Data/tianshu/");
    expect(readConfiguredDataRoot()).toBe("/Volumes/Data/tianshu");
  });

  it("相对路径写入抛错（配置必须显式绝对路径）", () => {
    expect(() => writeConfiguredDataRoot("relative/dir")).toThrow(
      /DATA_ROOT_MUST_BE_ABSOLUTE/,
    );
  });

  it("null 清除配置（恢复默认）", () => {
    writeConfiguredDataRoot("/Volumes/Data/tianshu");
    expect(readConfiguredDataRoot()).toBe("/Volumes/Data/tianshu");
    writeConfiguredDataRoot(null);
    expect(readConfiguredDataRoot()).toBeNull();
  });

  it("suppress 后读取恒 null（启动期不可写回退），不影响配置文件本身", () => {
    writeConfiguredDataRoot("/Volumes/Data/tianshu");
    suppressConfiguredDataRoot();
    expect(readConfiguredDataRoot()).toBeNull();
    expect(fs.existsSync(path.join(base, "data-root.json"))).toBe(true);
  });
});

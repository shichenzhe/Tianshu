import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import i18n, { LOCALE_KEY, setLocale } from "./index";
import enChat from "./locales/en-US/chat.json";
import enCommon from "./locales/en-US/common.json";
import enConnections from "./locales/en-US/connections.json";
import enExperts from "./locales/en-US/experts.json";
import enLibrary from "./locales/en-US/library.json";
import enMemory from "./locales/en-US/memory.json";
import enBackup from "./locales/en-US/backup.json";
import enMcp from "./locales/en-US/mcp.json";
import enMonitor from "./locales/en-US/monitor.json";
import enNotify from "./locales/en-US/notify.json";
import enOrchestration from "./locales/en-US/orchestration.json";
import enPermission from "./locales/en-US/permission.json";
import enProject from "./locales/en-US/project.json";
import enProviders from "./locales/en-US/providers.json";
import enSettings from "./locales/en-US/settings.json";
import enSkills from "./locales/en-US/skills.json";
import enWorkspace from "./locales/en-US/workspace.json";
import zhChat from "./locales/zh-CN/chat.json";
import zhCommon from "./locales/zh-CN/common.json";
import zhConnections from "./locales/zh-CN/connections.json";
import zhExperts from "./locales/zh-CN/experts.json";
import zhLibrary from "./locales/zh-CN/library.json";
import zhMemory from "./locales/zh-CN/memory.json";
import zhBackup from "./locales/zh-CN/backup.json";
import zhMcp from "./locales/zh-CN/mcp.json";
import zhMonitor from "./locales/zh-CN/monitor.json";
import zhNotify from "./locales/zh-CN/notify.json";
import zhOrchestration from "./locales/zh-CN/orchestration.json";
import zhPermission from "./locales/zh-CN/permission.json";
import zhProject from "./locales/zh-CN/project.json";
import zhProviders from "./locales/zh-CN/providers.json";
import zhSettings from "./locales/zh-CN/settings.json";
import zhSkills from "./locales/zh-CN/skills.json";
import zhWorkspace from "./locales/zh-CN/workspace.json";

// —— AsyncStorage 内存 Map 替身（node vitest 环境无 RN 原生模块，照 connections.store.test.ts 做法） ——
const storageMock = vi.hoisted(() => {
  const storage = new Map<string, string>();
  return {
    storage,
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      storage.set(key, value);
      return Promise.resolve();
    }),
  };
});

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: storageMock,
}));

type Json = Record<string, unknown>;

/** 递归收集叶子 key 全路径（对象下钻，其余视为叶子）。 */
function collectKeys(value: Json, prefix = ""): string[] {
  const keys: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child !== null && typeof child === "object" && !Array.isArray(child)) {
      keys.push(...collectKeys(child as Json, path));
    } else {
      keys.push(path);
    }
  }
  return keys;
}

const namespaces: Array<[string, Json, Json]> = [
  ["common", zhCommon, enCommon],
  ["connections", zhConnections, enConnections],
  ["chat", zhChat, enChat],
  ["settings", zhSettings, enSettings],
  ["orchestration", zhOrchestration, enOrchestration],
  ["permission", zhPermission, enPermission],
  ["notify", zhNotify, enNotify],
  ["monitor", zhMonitor, enMonitor],
  ["providers", zhProviders, enProviders],
  ["library", zhLibrary, enLibrary],
  ["project", zhProject, enProject],
  ["workspace", zhWorkspace, enWorkspace],
  ["experts", zhExperts, enExperts],
  ["skills", zhSkills, enSkills],
  ["mcp", zhMcp, enMcp],
  ["memory", zhMemory, enMemory],
  ["backup", zhBackup, enBackup],
];

describe("i18n 双语 key 齐平（防单语漏 key）", () => {
  for (const [name, zh, en] of namespaces) {
    it(`${name} namespace zh-CN 与 en-US key 集合逐层一致`, () => {
      const zhKeys = collectKeys(zh).sort();
      expect(zhKeys.length).toBeGreaterThan(0);
      expect(collectKeys(en).sort()).toEqual(zhKeys);
    });
  }

  it("chat namespace 含 approveUnsupported（T15 远端审批用）", () => {
    expect(zhChat).toHaveProperty("approveUnsupported");
    expect(enChat).toHaveProperty("approveUnsupported");
  });

  it("namespaces 数组与 locales 目录 JSON 文件名一致（M4：漏登记即红）", () => {
    // locales 目录是资源真值：新增 ns JSON 文件而未 import/未登记进
    // namespaces 数组（双语齐平用例不覆盖）时此用例红
    const registered = namespaces.map(([name]) => name).sort();
    for (const locale of ["zh-CN", "en-US"] as const) {
      const dir = path.join(import.meta.dirname, "locales", locale);
      const files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(/\.json$/, ""))
        .sort();
      expect(files).toEqual(registered);
    }
  });
});

describe("setLocale 语言切换与持久化", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    storageMock.storage.clear();
    storageMock.setItem.mockClear();
  });

  it('setLocale("en-US") 切换 i18n.language 且写入 AsyncStorage', async () => {
    setLocale("en-US");
    await vi.waitFor(() => expect(i18n.language).toBe("en-US"));
    expect(storageMock.setItem).toHaveBeenCalledWith(LOCALE_KEY, "en-US");
  });

  it("模块加载时从 AsyncStorage 恢复已持久化语言", async () => {
    // 注：vitest 在 import 阶段与测试执行之间会清理 spy 调用记录，
    // 顶层恢复逻辑必须用 vi.resetModules + 动态重载在测试期内观察。
    storageMock.storage.set(LOCALE_KEY, "en-US");
    vi.resetModules();
    const fresh = await import("./index");
    await vi.waitFor(() => expect(fresh.default.language).toBe("en-US"));
  });

  it("持久化值为非法语言（如 fr）时忽略，语言保持 zh-CN 不回落英文", async () => {
    storageMock.storage.set(LOCALE_KEY, "fr");
    vi.resetModules();
    const fresh = await import("./index");
    // setImmediate 让 getItem 的 .then/.catch 微任务链先行跑完再断言（waitFor 对恒真条件会秒过，测不到回退）
    await new Promise((resolve) => setImmediate(resolve));
    expect(fresh.default.language).toBe("zh-CN");
  });
});

describe("LOCALE_KEY 迁移（M4：tianshu-mobile-locale → tianshu-mobile.locale）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    storageMock.storage.clear();
    storageMock.setItem.mockClear();
  });

  it("新 key 空、旧 key 有合法值：恢复旧值并迁入写新档（旧档保留）", async () => {
    storageMock.storage.set("tianshu-mobile-locale", "en-US");
    vi.resetModules();
    const fresh = await import("./index");
    await vi.waitFor(() => expect(fresh.default.language).toBe("en-US"));
    // setImmediate 冲刷迁移的 fire-and-forget 写
    await new Promise((resolve) => setImmediate(resolve));
    expect(storageMock.storage.get(LOCALE_KEY)).toBe("en-US");
    expect(storageMock.storage.get("tianshu-mobile-locale")).toBe("en-US");
  });

  it("新 key 已有值：优先新档，旧档不参与（不被旧值覆写）", async () => {
    storageMock.storage.set(LOCALE_KEY, "zh-CN");
    storageMock.storage.set("tianshu-mobile-locale", "en-US");
    vi.resetModules();
    const fresh = await import("./index");
    await new Promise((resolve) => setImmediate(resolve));
    expect(fresh.default.language).toBe("zh-CN");
    expect(storageMock.storage.get(LOCALE_KEY)).toBe("zh-CN");
  });
});

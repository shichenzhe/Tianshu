// @vitest-environment jsdom
/**
 * 快捷键基建测试（jsdom：localStorage + KeyboardEvent 构造）：
 * - 解析/序列化往返：抽象输入归一（Escape→Esc、+→=、单字符小写、固定
 *   顺序）、反解析容错、KeyboardEvent 薄适配（平台修饰键归一）
 * - 平台符号矩阵：darwin ⌘⇧^⌥ + 单字母大写 / win·linux Ctrl+Shift+Alt 字面
 * - 有效性矩阵：Enter/Esc/@// 裸绑或含 cmd/ctrl/alt 有效，裸/仅 shift 拒绝
 * - 冲突查找：占用判定含固定绑定、跳过自身、unbound 释放占用
 * - localStorage 哨兵语义：null→"unbound"、单条清除、整体重置、损坏容错
 * - 合成视图：默认 ∪ 覆盖（覆盖优先）∪ unbound→null、非法覆盖回退默认
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// localStorage stub：与 tests/app-settings/font-scale.test.ts 同款内存
// stub（Node 26 无 --localstorage-file 时原生全局访问会向 stderr 打
// ExperimentalWarning，先行替换消除噪音）
vi.hoisted(() => {
  const memory = new Map<string, string>();
  const stub = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
    clear: () => memory.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: stub,
    configurable: true,
    writable: true,
  });
});

import {
  KEYBINDING_COMMANDS,
  KEYBINDINGS_STORAGE_KEY,
  UNBOUND,
  bindingFromKeyEvent,
  clearOverride,
  detectPlatform,
  findConflict,
  formatBinding,
  isSystemLevelCombo,
  isValidNewBinding,
  loadOverrides,
  parseBindingString,
  parseKeyBinding,
  resetAll,
  resolveBindings,
  saveOverride,
  serializeBinding,
} from "../../src-react/lib/keybindings";
import type { KeyBinding } from "../../src-react/lib/keybindings";

/** 快捷构造绑定（序列化 → KeyBinding；测试用例均已保证合法） */
function bindingOf(serialized: string): KeyBinding {
  const binding = parseBindingString(serialized);
  if (!binding) throw new Error(`测试构造失败: ${serialized}`);
  return binding;
}

/** 读取原始存储内容（未经容错解析） */
function rawStorage(): string | null {
  return localStorage.getItem(KEYBINDINGS_STORAGE_KEY);
}

beforeEach(() => {
  localStorage.clear();
});

describe("解析与序列化往返", () => {
  it("抽象输入归一：修饰键固定顺序、Escape→Esc、+→=、单字符小写", () => {
    expect(parseKeyBinding(["shift", "cmd"], "b")).toEqual({
      modifiers: ["cmd", "shift"],
      key: "b",
    });
    expect(parseKeyBinding([], "Escape")).toEqual({
      modifiers: [],
      key: "Esc",
    });
    expect(parseKeyBinding(["cmd"], "+")).toEqual({
      modifiers: ["cmd"],
      key: "=",
    });
    expect(parseKeyBinding(["alt"], "A")).toEqual({
      modifiers: ["alt"],
      key: "a",
    });
    expect(parseKeyBinding(["cmd"], "[")).toEqual({
      modifiers: ["cmd"],
      key: "[",
    });
  });

  it("空主键或仅按下修饰键（组合未完成）返回 null", () => {
    expect(parseKeyBinding(["cmd"], "")).toBeNull();
    expect(parseKeyBinding(["cmd"], "Meta")).toBeNull();
    expect(parseKeyBinding([], "Shift")).toBeNull();
    expect(parseKeyBinding(["alt"], "Control")).toBeNull();
  });

  it("序列化：无修饰键仅 key，多修饰键按 cmd/ctrl/alt/shift 固定顺序", () => {
    expect(serializeBinding(bindingOf("Enter"))).toBe("Enter");
    expect(serializeBinding(bindingOf("cmd+shift+b"))).toBe("cmd+shift+b");
    expect(serializeBinding(bindingOf("ctrl+cmd+f"))).toBe("cmd+ctrl+f");
    expect(serializeBinding(bindingOf("shift+alt+w"))).toBe("alt+shift+w");
    expect(serializeBinding(bindingOf("@"))).toBe("@");
  });

  it("反解析容错：token 顺序不敏感，非法输入返回 null", () => {
    expect(parseBindingString("shift+cmd+b")).toEqual({
      modifiers: ["cmd", "shift"],
      key: "b",
    });
    expect(parseBindingString("cmd+=")).toEqual({
      modifiers: ["cmd"],
      key: "=",
    });
    for (const invalid of ["", "cmd+", "cmd", "foo+b", "cmd+shift++", "Meta"]) {
      expect(parseBindingString(invalid)).toBeNull();
    }
  });

  it("17 条默认绑定 parse↔serialize 往返稳定", () => {
    for (const command of KEYBINDING_COMMANDS) {
      const serialized = serializeBinding(command.defaultBinding);
      expect(parseBindingString(serialized)).toEqual(command.defaultBinding);
      expect(
        serializeBinding(parseBindingString(serialized) as KeyBinding),
      ).toBe(serialized);
    }
  });

  it("KeyboardEvent 适配：darwin metaKey→cmd·ctrlKey→ctrl；win ctrlKey→cmd", () => {
    const darwinCmdB = new KeyboardEvent("keydown", {
      key: "b",
      metaKey: true,
    });
    expect(serializeBinding(bindingFromKeyEvent(darwinCmdB, "darwin")!)).toBe(
      "cmd+b",
    );
    const darwinFullScreen = new KeyboardEvent("keydown", {
      key: "f",
      metaKey: true,
      ctrlKey: true,
    });
    expect(
      serializeBinding(bindingFromKeyEvent(darwinFullScreen, "darwin")!),
    ).toBe("cmd+ctrl+f");
    const winCtrlF = new KeyboardEvent("keydown", { key: "f", ctrlKey: true });
    expect(serializeBinding(bindingFromKeyEvent(winCtrlF, "win")!)).toBe(
      "cmd+f",
    );
    const escape = new KeyboardEvent("keydown", { key: "Escape" });
    expect(bindingFromKeyEvent(escape, "darwin")).toEqual({
      modifiers: [],
      key: "Esc",
    });
    const modifierOnly = new KeyboardEvent("keydown", {
      key: "Meta",
      metaKey: true,
    });
    expect(bindingFromKeyEvent(modifierOnly, "darwin")).toBeNull();
  });
});

describe("命令定义表", () => {
  it("共 17 条：11 条可自定义 + 6 条系统固定，id 唯一", () => {
    expect(KEYBINDING_COMMANDS).toHaveLength(17);
    const ids = KEYBINDING_COMMANDS.map((command) => command.id);
    expect(new Set(ids).size).toBe(17);
    expect(KEYBINDING_COMMANDS.filter((c) => c.customizable)).toHaveLength(11);
    expect(KEYBINDING_COMMANDS.filter((c) => !c.customizable)).toHaveLength(6);
  });

  it("默认绑定与设计裁决表一致（序列化快照）", () => {
    const serialized = Object.fromEntries(
      KEYBINDING_COMMANDS.map((command) => [
        command.id,
        serializeBinding(command.defaultBinding),
      ]),
    );
    expect(serialized).toEqual({
      openSettings: "cmd+,",
      sessionSearch: "cmd+f",
      sendMessage: "Enter",
      newlineInInput: "shift+Enter",
      newConversation: "cmd+n",
      stopGeneration: "Esc",
      previousTask: "cmd+[",
      nextTask: "cmd+]",
      toggleSidebar: "cmd+b",
      toggleArtifacts: "cmd+shift+b",
      toggleFullscreen: "cmd+ctrl+f",
      showHideWindow: "alt+shift+w",
      zoomIn: "cmd+=",
      zoomOut: "cmd+-",
      zoomReset: "cmd+0",
      atMention: "@",
      slashCommand: "/",
    });
  });

  it("默认表内部无冲突（任意两条序列化互异）", () => {
    const resolved = resolveBindings({});
    for (const command of KEYBINDING_COMMANDS) {
      expect(
        findConflict(command.id, command.defaultBinding, resolved),
      ).toBeNull();
    }
  });
});

describe("平台符号渲染", () => {
  it("darwin：修饰键 ⌘/^/⌥/⇧ + 单字母大写，命名键/符号原样", () => {
    expect(formatBinding(bindingOf("cmd+shift+b"), "darwin")).toEqual([
      "⌘",
      "⇧",
      "B",
    ]);
    expect(formatBinding(bindingOf("cmd+ctrl+f"), "darwin")).toEqual([
      "⌘",
      "^",
      "F",
    ]);
    expect(formatBinding(bindingOf("shift+alt+w"), "darwin")).toEqual([
      "⌥",
      "⇧",
      "W",
    ]);
    expect(formatBinding(bindingOf("Enter"), "darwin")).toEqual(["Enter"]);
    expect(formatBinding(bindingOf("Esc"), "darwin")).toEqual(["Esc"]);
    expect(formatBinding(bindingOf("cmd+,"), "darwin")).toEqual(["⌘", ","]);
    expect(formatBinding(bindingOf("cmd+="), "darwin")).toEqual(["⌘", "="]);
    expect(formatBinding(bindingOf("cmd+-"), "darwin")).toEqual(["⌘", "-"]);
    expect(formatBinding(bindingOf("cmd+0"), "darwin")).toEqual(["⌘", "0"]);
    expect(formatBinding(bindingOf("cmd+["), "darwin")).toEqual(["⌘", "["]);
    expect(formatBinding(bindingOf("@"), "darwin")).toEqual(["@"]);
    expect(formatBinding(bindingOf("/"), "darwin")).toEqual(["/"]);
  });

  it("win/linux：Ctrl/Shift/Alt 标签 + 主键字面（单字母不大写）", () => {
    expect(formatBinding(bindingOf("cmd+shift+b"), "win")).toEqual([
      "Ctrl",
      "Shift",
      "b",
    ]);
    expect(formatBinding(bindingOf("cmd+f"), "linux")).toEqual(["Ctrl", "f"]);
    expect(formatBinding(bindingOf("shift+alt+w"), "win")).toEqual([
      "Alt",
      "Shift",
      "w",
    ]);
    expect(formatBinding(bindingOf("Enter"), "win")).toEqual(["Enter"]);
  });
});

describe("有效性矩阵", () => {
  it("主键 Enter/Esc/@// 裸绑有效（含仅 shift 组合）", () => {
    for (const serialized of [
      "Enter",
      "Esc",
      "@",
      "/",
      "shift+Enter",
      "cmd+Enter",
    ]) {
      expect(isValidNewBinding(bindingOf(serialized))).toBe(true);
    }
  });

  it("含 cmd/ctrl/alt 修饰键有效", () => {
    for (const serialized of [
      "cmd+a",
      "ctrl+x",
      "alt+q",
      "cmd+shift+9",
      "ctrl+alt+delete",
    ]) {
      expect(isValidNewBinding(bindingOf(serialized))).toBe(true);
    }
  });

  it("裸单字符与仅 shift+单字符无效", () => {
    for (const serialized of ["a", ",", "9", "=", "[", "shift+a", "shift+9"]) {
      expect(isValidNewBinding(bindingOf(serialized))).toBe(false);
    }
  });
});

describe("冲突查找", () => {
  it("占用同一序列化的其他命令（默认表：cmd+f 被 sessionSearch 占用）", () => {
    const resolved = resolveBindings({});
    const conflict = findConflict(
      "newConversation",
      bindingOf("cmd+f"),
      resolved,
    );
    expect(conflict?.id).toBe("sessionSearch");
    expect(conflict?.customizable).toBe(true);
  });

  it("固定绑定同样参与占用判定（cmd+0 被 zoomReset 占用）", () => {
    const resolved = resolveBindings({});
    const conflict = findConflict("openSettings", bindingOf("cmd+0"), resolved);
    expect(conflict?.id).toBe("zoomReset");
    expect(conflict?.customizable).toBe(false);
  });

  it("跳过自身；未被占用的绑定与 null 绑定无冲突", () => {
    const resolved = resolveBindings({});
    expect(
      findConflict("sessionSearch", bindingOf("cmd+f"), resolved),
    ).toBeNull();
    expect(
      findConflict("openSettings", bindingOf("cmd+k"), resolved),
    ).toBeNull();
    expect(findConflict("openSettings", null, resolved)).toBeNull();
  });

  it("覆盖迁移占用：改绑释放原键、unbound 释放默认键", () => {
    const resolved = resolveBindings({
      sessionSearch: "cmd+k",
      sendMessage: UNBOUND,
    });
    expect(
      findConflict("openSettings", bindingOf("cmd+f"), resolved),
    ).toBeNull();
    expect(
      findConflict("openSettings", bindingOf("Enter"), resolved),
    ).toBeNull();
    expect(
      findConflict("sessionSearch", bindingOf("cmd+k"), resolved),
    ).toBeNull();
  });
});

describe("localStorage 哨兵语义", () => {
  it("saveOverride 仅存用户改动；null 写 unbound 哨兵", () => {
    saveOverride("openSettings", bindingOf("cmd+k"));
    saveOverride("sendMessage", null);
    expect(JSON.parse(rawStorage() as string)).toEqual({
      openSettings: "cmd+k",
      sendMessage: "unbound",
    });
    expect(loadOverrides()).toEqual({
      openSettings: "cmd+k",
      sendMessage: "unbound",
    });
  });

  it("clearOverride 清除单条（其余保留），该命令恢复默认语义", () => {
    saveOverride("openSettings", bindingOf("cmd+k"));
    saveOverride("stopGeneration", bindingOf("cmd+p"));
    clearOverride("openSettings");
    expect(loadOverrides()).toEqual({ stopGeneration: "cmd+p" });
  });

  it("resetAll 整体移除存储键；末条覆盖清除后不留空对象", () => {
    saveOverride("openSettings", bindingOf("cmd+k"));
    resetAll();
    expect(rawStorage()).toBeNull();
    saveOverride("openSettings", bindingOf("cmd+k"));
    clearOverride("openSettings");
    expect(rawStorage()).toBeNull();
  });

  it("损坏 JSON/非法结构容错回退空对象", () => {
    for (const corrupted of [
      "{oops",
      "[1,2]",
      '{"openSettings":"cmd+k","bad":1}',
      "null",
    ]) {
      localStorage.setItem(KEYBINDINGS_STORAGE_KEY, corrupted);
      expect(loadOverrides()).toEqual({});
    }
  });
});

describe("合成视图（默认 ∪ 覆盖，覆盖优先）", () => {
  it("无覆盖时全部命中默认绑定", () => {
    const resolved = resolveBindings({});
    expect(Object.keys(resolved)).toHaveLength(17);
    expect(resolved.sendMessage).toEqual({ modifiers: [], key: "Enter" });
    expect(resolved.toggleArtifacts).toEqual({
      modifiers: ["cmd", "shift"],
      key: "b",
    });
    expect(resolved.atMention).toEqual({ modifiers: [], key: "@" });
  });

  it("覆盖优先于默认；unbound 解析为 null", () => {
    const resolved = resolveBindings({
      sessionSearch: "cmd+k",
      sendMessage: UNBOUND,
    });
    expect(serializeBinding(resolved.sessionSearch as KeyBinding)).toBe(
      "cmd+k",
    );
    expect(resolved.sendMessage).toBeNull();
  });

  it("未知命令 id 的覆盖被忽略；非法序列化覆盖回退默认", () => {
    const resolved = resolveBindings({
      unknownId: "cmd+z",
      openSettings: "cmd+",
    });
    expect(Object.keys(resolved)).toHaveLength(17);
    expect(resolved.unknownId).toBeUndefined();
    expect(serializeBinding(resolved.openSettings as KeyBinding)).toBe("cmd+,");
  });
});

describe("系统级组合与平台探测", () => {
  it("darwin 已知系统组合命中（仅警告用，绑定仍被允许）", () => {
    expect(isSystemLevelCombo(bindingOf("cmd+,"), "darwin")).toBe(true);
    expect(isSystemLevelCombo(bindingOf("cmd+q"), "darwin")).toBe(true);
    expect(isSystemLevelCombo(bindingOf("cmd+w"), "darwin")).toBe(true);
    expect(isSystemLevelCombo(bindingOf("cmd+k"), "darwin")).toBe(false);
    expect(isSystemLevelCombo(bindingOf("shift+alt+w"), "darwin")).toBe(false);
  });

  it("win/linux 不触发系统组合警告", () => {
    expect(isSystemLevelCombo(bindingOf("cmd+q"), "win")).toBe(false);
    expect(isSystemLevelCombo(bindingOf("cmd+,"), "linux")).toBe(false);
  });

  it("detectPlatform 按 userAgent 探测", () => {
    const stub = (ua: string) =>
      Object.defineProperty(window.navigator, "userAgent", {
        value: ua,
        configurable: true,
      });
    stub("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    expect(detectPlatform()).toBe("darwin");
    stub("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    expect(detectPlatform()).toBe("win");
    stub("Mozilla/5.0 (X11; Linux x86_64)");
    expect(detectPlatform()).toBe("linux");
    delete (window.navigator as { userAgent?: string }).userAgent;
  });
});

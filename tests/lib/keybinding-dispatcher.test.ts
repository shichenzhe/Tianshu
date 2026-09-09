// @vitest-environment jsdom
/**
 * 快捷键分发匹配矩阵测试（jsdom：currentBindings 读 localStorage）：
 * - 默认绑定命中：darwin（⌘=metaKey/^=ctrlKey）与 win·linux（Ctrl=cmd）双平台矩阵
 * - 消费者优先（defaultPrevented）、长按 repeat、纯修饰键/空主键不命中
 * - 覆盖即时生效：改绑命中新键、解绑（unbound）原键落空
 * - 输入框聚焦语义：带修饰键命令仍触发，裸可打印键（Enter/@//）不触发，
 *   裸非打印键（Esc/F11）仍触发
 * - win/linux 裸 F11 平台等价键映射 toggleFullscreen（darwin 不映射，带修饰
 *   不映射；仅全屏绑定保持默认时映射——解绑/改绑后落空，遵守删除契约）
 * - 同键占用按定义表顺序取首个（冲突容错）
 * - eventMatchesBinding：输入框内发送/换行判定的匹配原语（含平台归一）
 * - currentBindings：localStorage 覆盖直读（每次按键即时合成）
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// localStorage stub：与 tests/lib/keybindings.test.ts 同款内存 stub
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
  KEYBINDINGS_STORAGE_KEY,
  loadOverrides,
  parseBindingString,
  resolveBindings,
  serializeBinding,
  UNBOUND,
} from "../../src-react/lib/keybindings";
import {
  currentBindings,
  eventMatchesBinding,
  matchKeybindingCommand,
  type DispatchKeyEvent,
  type DispatchMatchInput,
} from "../../src-react/lib/keybindings/dispatcher";
import type { ResolvedBindings } from "../../src-react/lib/keybindings";

beforeEach(() => {
  localStorage.clear();
});

/** 便捷构造：默认绑定 + 指定覆盖 → 匹配结果 */
function match(
  key: string,
  modifiers: Partial<
    Pick<DispatchKeyEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">
  > = {},
  extra: Partial<DispatchMatchInput> = {},
  bindings: ResolvedBindings = resolveBindings({}),
): string | null {
  return matchKeybindingCommand(bindings, {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    platform: "darwin",
    inputFocused: false,
    defaultPrevented: false,
    repeat: false,
    ...modifiers,
    ...extra,
  });
}

describe("默认绑定命中（darwin）", () => {
  it("17 条命令按默认绑定逐条命中（⌘=metaKey、^=ctrlKey 归一）", () => {
    expect(match(",", { metaKey: true })).toBe("openSettings");
    expect(match("f", { metaKey: true })).toBe("sessionSearch");
    expect(match("Enter")).toBe("sendMessage");
    expect(match("Enter", { shiftKey: true })).toBe("newlineInInput");
    expect(match("n", { metaKey: true })).toBe("newConversation");
    expect(match("Escape")).toBe("stopGeneration");
    expect(match("[", { metaKey: true })).toBe("previousTask");
    expect(match("]", { metaKey: true })).toBe("nextTask");
    expect(match("b", { metaKey: true })).toBe("toggleSidebar");
    expect(match("b", { metaKey: true, shiftKey: true })).toBe(
      "toggleArtifacts",
    );
    expect(match("f", { metaKey: true, ctrlKey: true })).toBe(
      "toggleFullscreen",
    );
    expect(match("=", { metaKey: true })).toBe("zoomIn");
    expect(match("-", { metaKey: true })).toBe("zoomOut");
    expect(match("0", { metaKey: true })).toBe("zoomReset");
    expect(match("w", { altKey: true, shiftKey: true })).toBe("showHideWindow");
    expect(match("@")).toBe("atMention");
    expect(match("/")).toBe("slashCommand");
  });

  it("未命中场景：其他键、多余修饰键、大小写归一差异", () => {
    expect(match("k", { metaKey: true })).toBeNull();
    // toggleSidebar 是 ⌘B：带 ⌥ 不再命中
    expect(match("b", { metaKey: true, altKey: true })).toBeNull();
    // 大小写归一：B 与 b 等价（normalizeKey 单字符小写化）
    expect(match("B", { metaKey: true })).toBe("toggleSidebar");
  });

  it("shift 产生的 + 符号与 cmd+= 等价（拦住 Chromium ⌘+ 页面缩放）", () => {
    // mac ⌘⇧= 实际产生 key="+" + shift：剥离 shift 后归一为 "=" 命中 zoomIn
    expect(match("+", { metaKey: true, shiftKey: true })).toBe("zoomIn");
    expect(
      match("+", { ctrlKey: true, shiftKey: true }, { platform: "win" }),
    ).toBe("zoomIn");
    // 显式 shift+ "="（cmd+shift+=）不在默认绑定内，不命中
    expect(match("=", { metaKey: true, shiftKey: true })).toBeNull();
  });
});

describe("win/linux 修饰键归一", () => {
  it("Ctrl=cmd：布局命令在 win/linux 以 Ctrl 触发", () => {
    for (const platform of ["win", "linux"] as const) {
      expect(match(",", { ctrlKey: true }, { platform })).toBe("openSettings");
      expect(match("f", { ctrlKey: true }, { platform })).toBe("sessionSearch");
      expect(match("b", { ctrlKey: true }, { platform })).toBe("toggleSidebar");
      expect(match("w", { altKey: true, shiftKey: true }, { platform })).toBe(
        "showHideWindow",
      );
    }
  });

  it("win/linux 裸 F11 平台等价键映射 toggleFullscreen", () => {
    expect(match("F11", {}, { platform: "win" })).toBe("toggleFullscreen");
    expect(match("F11", {}, { platform: "linux" })).toBe("toggleFullscreen");
    // darwin 无此惯例；带修饰键的 F11 不映射（F11 非用户可绑键，无绑定可命中）
    expect(match("F11", {}, { platform: "darwin" })).toBeNull();
    expect(match("F11", { ctrlKey: true }, { platform: "win" })).toBeNull();
  });

  it("F11 等价键遵守删除契约：解绑或改绑非默认后裸 F11 落空", () => {
    // 解绑（unbound 哨兵）：行显示未绑定，F11 不得再切换全屏
    const unbound = resolveBindings({ toggleFullscreen: UNBOUND });
    expect(match("F11", {}, { platform: "win" }, unbound)).toBeNull();
    expect(match("F11", {}, { platform: "linux" }, unbound)).toBeNull();
    // 改绑为可命中键：UI 按实际绑定展示，F11 不再是等价键
    const rebound = resolveBindings({ toggleFullscreen: "cmd+shift+f" });
    expect(match("F11", {}, { platform: "win" }, rebound)).toBeNull();
    // 改绑键本身可命中（与默认 F11 等价键互为对照）
    expect(
      match(
        "f",
        { ctrlKey: true, shiftKey: true },
        { platform: "win" },
        rebound,
      ),
    ).toBe("toggleFullscreen");
    expect(match("F11", {}, { platform: "win" }, resolveBindings({}))).toBe(
      "toggleFullscreen",
    );
  });
});

describe("消费者优先与无效输入", () => {
  it("defaultPrevented 事件不参与分发（联想面板/编辑态的 Esc 先行消费）", () => {
    expect(match("Escape", {}, { defaultPrevented: true })).toBeNull();
    expect(
      match(",", { metaKey: true }, { defaultPrevented: true }),
    ).toBeNull();
  });

  it("长按 repeat 跳过（toggle 类命令防连打）", () => {
    expect(match("b", { metaKey: true }, { repeat: true })).toBeNull();
  });

  it("纯修饰键与空主键不命中（组合未完成）", () => {
    expect(match("Meta", { metaKey: true })).toBeNull();
    expect(match("Shift", { shiftKey: true })).toBeNull();
    expect(match("Control", { ctrlKey: true })).toBeNull();
    expect(match("")).toBeNull();
  });
});

describe("覆盖即时生效", () => {
  it("改绑命中新键、原键落空", () => {
    const bindings = resolveBindings({ openSettings: "cmd+k" });
    expect(match("k", { metaKey: true }, {}, bindings)).toBe("openSettings");
    expect(match(",", { metaKey: true }, {}, bindings)).toBeNull();
  });

  it("解绑（unbound 哨兵）后原键不再命中任何命令", () => {
    const bindings = resolveBindings({ stopGeneration: UNBOUND });
    expect(match("Escape", {}, {}, bindings)).toBeNull();
  });
});

describe("输入框聚焦语义", () => {
  it("带修饰键的布局命令仍触发", () => {
    expect(match(",", { metaKey: true }, { inputFocused: true })).toBe(
      "openSettings",
    );
    expect(
      match("b", { metaKey: true, shiftKey: true }, { inputFocused: true }),
    ).toBe("toggleArtifacts");
    expect(
      match("w", { altKey: true, shiftKey: true }, { inputFocused: true }),
    ).toBe("showHideWindow");
  });

  it("裸可打印键不触发（Enter/@// 由输入框内部处理）", () => {
    expect(match("Enter", {}, { inputFocused: true })).toBeNull();
    expect(match("@", {}, { inputFocused: true })).toBeNull();
    expect(match("/", {}, { inputFocused: true })).toBeNull();
  });

  it("裸非打印键仍触发（Esc/F 功能键无文本副作用）", () => {
    expect(match("Escape", {}, { inputFocused: true })).toBe("stopGeneration");
    expect(match("F11", {}, { inputFocused: true, platform: "win" })).toBe(
      "toggleFullscreen",
    );
  });

  it("裸键改绑到布局命令时聚焦同样被挡（如 stopGeneration 改绑 Enter）", () => {
    // 同时解绑 sendMessage（其默认即 Enter，定义表顺序在 stopGeneration 前）
    const bindings = resolveBindings({
      sendMessage: UNBOUND,
      stopGeneration: "Enter",
    });
    expect(match("Enter", {}, { inputFocused: true }, bindings)).toBeNull();
    expect(match("Enter", {}, { inputFocused: false }, bindings)).toBe(
      "stopGeneration",
    );
  });
});

describe("同键占用的冲突容错", () => {
  it("两条命令占同一序列化时按定义表顺序取首个", () => {
    // 构造 nextTask 改绑到 cmd+[：与 previousTask 默认同键，
    // previousTask 在定义表中靠前，应胜出
    const bindings = resolveBindings({ nextTask: "cmd+[" });
    expect(match("[", { metaKey: true }, {}, bindings)).toBe("previousTask");
  });
});

describe("eventMatchesBinding（输入框内判定原语）", () => {
  const event = (key: string, modifiers: Partial<DispatchKeyEvent> = {}) => ({
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...modifiers,
  });

  it("默认发送/换行绑定：Enter 与 Shift+Enter 分别命中", () => {
    const bindings = resolveBindings({});
    expect(
      eventMatchesBinding(event("Enter"), bindings.sendMessage, "darwin"),
    ).toBe(true);
    expect(
      eventMatchesBinding(
        event("Enter", { shiftKey: true }),
        bindings.sendMessage,
        "darwin",
      ),
    ).toBe(false);
    expect(
      eventMatchesBinding(
        event("Enter", { shiftKey: true }),
        bindings.newlineInInput,
        "darwin",
      ),
    ).toBe(true);
  });

  it("平台修饰键归一：win Ctrl 命中 cmd 绑定、darwin ^ 不冒充 cmd", () => {
    const cmdEnter = parseBindingString("cmd+Enter");
    expect(
      eventMatchesBinding(event("Enter", { ctrlKey: true }), cmdEnter, "win"),
    ).toBe(true);
    expect(
      eventMatchesBinding(
        event("Enter", { ctrlKey: true }),
        cmdEnter,
        "darwin",
      ),
    ).toBe(false);
    expect(
      eventMatchesBinding(
        event("Enter", { metaKey: true }),
        cmdEnter,
        "darwin",
      ),
    ).toBe(true);
  });

  it("null 绑定与修饰键不匹配的裸键不命中", () => {
    expect(eventMatchesBinding(event("Enter"), null, "darwin")).toBe(false);
    expect(
      eventMatchesBinding(event("b"), parseBindingString("cmd+b"), "darwin"),
    ).toBe(false);
  });
});

describe("currentBindings（每次按键即时合成）", () => {
  it("无存储时与 resolveBindings({}) 等价；覆盖直读生效", () => {
    expect(currentBindings()).toEqual(resolveBindings({}));
    localStorage.setItem(
      KEYBINDINGS_STORAGE_KEY,
      JSON.stringify({ openSettings: "cmd+k" }),
    );
    expect(serializeBinding(currentBindings().openSettings!)).toBe("cmd+k");
    expect(loadOverrides()).toEqual({ openSettings: "cmd+k" });
  });
});

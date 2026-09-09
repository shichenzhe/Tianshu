/**
 * 快捷键基建类型定义
 * 纯数据模型：修饰键归一（cmd 统称 mac ⌘/win·linux Ctrl）、KeyBinding、
 * 命令定义、覆盖存储与合成视图；不含任何运行时逻辑
 */

/**
 * 归一后的修饰键
 * cmd：mac ⌘（metaKey）/ win·linux Ctrl 的统称，同一序列化在两平台都命中；
 * ctrl：独立保留（mac 的 ^，即 darwin 下 event.ctrlKey）；
 * alt：mac ⌥ / win·linux Alt；shift：两平台一致
 */
export type Modifier = "cmd" | "ctrl" | "alt" | "shift";

/** 运行平台（决定修饰键提取与符号渲染口径） */
export type Platform = "darwin" | "win" | "linux";

/** 归一后的按键绑定：修饰键集合（按 cmd/ctrl/alt/shift 固定顺序）+ 主键 */
export interface KeyBinding {
  modifiers: Modifier[];
  key: string;
}

/** 快捷键命令定义（17 条，见 commands.ts 定义表） */
export interface CommandDef {
  /** 命令 id（camelCase，同时作为 i18n key 与存储键） */
  id: string;
  /** 默认绑定（归一后的 KeyBinding） */
  defaultBinding: KeyBinding;
  /** 是否允许用户改绑（系统固定项为 false，仍参与冲突占用判定） */
  customizable: boolean;
}

/** 用户覆盖存储：仅记录用户改动；值为序列化绑定或 "unbound" 哨兵 */
export type BindingOverrides = Record<string, string>;

/** 合成视图：命令 id → 生效绑定（默认 ∪ 覆盖；unbound 或无默认为 null） */
export type ResolvedBindings = Record<string, KeyBinding | null>;

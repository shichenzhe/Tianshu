/**
 * 个性化配置纯常量段（PL-1 自 mirror
 * electron/domains/ai/personalization/personalization.config.ts 物理搬入）：
 * 类型、key 常量、限长与默认值——零依赖纯闭包，双仓单份。
 * 存储语义（mirror spec §3）：行不存在 = 用默认值；存在 = 用存的值（含空串）。
 * persona 默认空 = 未启用不注入（D6：DEFAULT_PERSONA 仅预填编辑弹窗，
 * 文案在前端 personalization-options.ts，不入包）。
 * option 行 → 配置解析（fromAppOptions）含 option-store 依赖
 * （parseBoolOption），读写留消费方（mirror config.ts / server
 * personalization.ts 各自持有，drift manifest 守护）。
 */

/** 回复风格枚举（default = 不注入风格段） */
export type ResponseStyle =
  | "default"
  | "professional"
  | "friendly"
  | "direct"
  | "imaginative"
  | "pragmatic"
  | "snarky"
  | "socratic";

/** option.name 常量（type="app"，统一 personalization. 前缀） */
export const PERSONALIZATION_KEYS = {
  responseStyle: "personalization.responseStyle",
  welcomeLoading: "personalization.welcomeLoading",
  fileChangeDetails: "personalization.fileChangeDetails",
  customInstructions: "personalization.customInstructions",
  userNickname: "personalization.userNickname",
  aiName: "personalization.aiName",
  persona: "personalization.persona",
  memory: "personalization.memory",
  memoryProfile: "personalization.memoryProfile",
  memoryEnabled: "personalization.memoryEnabled",
  memoryModelId: "personalization.memoryModelId",
  memoryLastCompiledAt: "personalization.memoryLastCompiledAt",
  memoryLastError: "personalization.memoryLastError",
} as const;

/**
 * per-user 命名空间字段（P2.1 记忆 userId 隔离，批9 2026-11-05）：
 * option 行无 userId 列（D8 不建表不加列），画像正文与其整理元数据按
 * `personalization.<userId>.<field>` 拆行实现多用户隔离；其余键（开关/
 * 整理模型/手动记忆/人设等）保持本机全局。旧全局键保留兼容读取
 * （升级迁移见 mirror personalization.repo）。
 */
export const PERSONALIZATION_USER_FIELDS = [
  "memoryProfile",
  "memoryLastCompiledAt",
  "memoryLastError",
] as const;

/** per-user key 拼接单源：主进程 repo 读写 / 前端 settings:set 同源 */
export function personalizationUserKey(userId: number, field: string): string {
  return `personalization.${userId}.${field}`;
}

/** 画像正文 per-user key（A 画像不进 B 对话的隔离载体） */
export function memoryProfileKeyFor(userId: number): string {
  return personalizationUserKey(userId, "memoryProfile");
}

/** 上次定时整理时间 per-user key */
export function memoryLastCompiledAtKeyFor(userId: number): string {
  return personalizationUserKey(userId, "memoryLastCompiledAt");
}

/** 最近整理失败原因 per-user key */
export function memoryLastErrorKeyFor(userId: number): string {
  return personalizationUserKey(userId, "memoryLastError");
}

/** 文本字段限长（解析端截断，防 IPC 直调绕过 UI 的 maxLength） */
export const PERSONALIZATION_LIMITS = {
  customInstructions: 1500,
  userNickname: 20,
  aiName: 20,
  persona: 4000,
  memory: 1500,
  memoryProfile: 8000,
  /** 强指定记忆整理模型 id（model.id 十进制字符串；空 = 自动解析） */
  memoryModelId: 10,
  /** 上次整理时间（ISO 字符串，正常 24 字符，留余量防脏数据） */
  memoryLastCompiledAt: 40,
  /** 最近一次整理失败原因截断（修订 A：失败可观测） */
  memoryLastError: 200,
} as const;

export interface PersonalizationConfig {
  responseStyle: ResponseStyle;
  welcomeLoading: boolean;
  fileChangeDetails: boolean;
  customInstructions: string;
  userNickname: string;
  aiName: string;
  persona: string;
  memory: string;
  memoryProfile: string;
  memoryEnabled: boolean;
  /** 强指定记忆整理模型（model.id 字符串；空 = 自动解析候选序） */
  memoryModelId: string;
  memoryLastCompiledAt: string;
  memoryLastError: string;
}

export function defaultPersonalization(): PersonalizationConfig {
  return {
    responseStyle: "default",
    welcomeLoading: true,
    fileChangeDetails: false,
    customInstructions: "",
    userNickname: "",
    aiName: "天枢",
    persona: "",
    memory: "",
    memoryProfile: "",
    memoryEnabled: true,
    memoryModelId: "",
    memoryLastCompiledAt: "",
    memoryLastError: "",
  };
}

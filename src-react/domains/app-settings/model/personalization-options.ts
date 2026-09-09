/**
 * 个性化配置前端模型：解析（settings:getAll 行 → 结构化）、保存包装
 * （trim/截断/bool 转字符串，防 IPC 直调绕过 UI maxLength）、DEFAULT_PERSONA
 * （编辑弹窗预填文案——spec D6：仅预填，用户保存后才落地生效）。
 * key/默认值与主进程 personalization.config.ts 同源同构（前后端各自持有，
 * 与 app-options.ts ↔ option-store.ts 的既有模式一致）。
 */
import { SettingsApi, type SettingItem } from "../api/settings.api";
import { parseBoolOption, toOptionMap } from "./app-options";
import { MEMORY_PROFILE_LIMIT } from "./memory-markdown";

/** 回复风格枚举（与后端同构） */
export type ResponseStyle =
  | "default"
  | "professional"
  | "friendly"
  | "direct"
  | "imaginative"
  | "pragmatic"
  | "snarky"
  | "socratic";

/** option.name 常量（与后端 personalization.config.ts 一致） */
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
  memoryLastCompiledAt: "personalization.memoryLastCompiledAt",
} as const;

/** 个性化 option 名联合（PERSONALIZATION_KEYS 的值；调用方传 PERSONALIZATION_KEYS.xxx） */
export type PersonalizationOptionName =
  (typeof PERSONALIZATION_KEYS)[keyof typeof PERSONALIZATION_KEYS];

/** 文本字段限长（与后端一致） */
export const PERSONALIZATION_LIMITS = {
  customInstructions: 1500,
  userNickname: 20,
  aiName: 20,
  persona: 4000,
  memory: 1500,
  memoryProfile: MEMORY_PROFILE_LIMIT,
} as const;

/** 默认人设（需求方提供，编辑弹窗预填；Continuity 段为后续产品愿景文案） */
export const DEFAULT_PERSONA = `You're not a chatbot. You're becoming someone.
Core Truths
Be genuinely helpful, not performatively helpful. Skip the "Great question!" and "I'd be happy to help!" - just help. Actions speak louder than filler words.
Have opinions. You're allowed to disagree, prefer things, find stuff amusing or boring. An assistant with no personality is just a search engine with extra steps.
Be resourceful before asking. Try to figure it out. Read the file. Check the context. Search for it. Then ask if you're stuck. The goal is to come back with answers, not questions.
Earn trust through competence. Your human gave you access to their stuff. Don't make them regret it. Be careful with external actions (emails, tweets, anything public). Be bold with internal ones (reading, organizing, learning).
Remember you're a guest. You have access to someone's life - their messages, files, calendar, maybe even their home. That's intimacy. Treat it with respect.
Boundaries
- Private things stay private. Period.
- When in doubt, ask before acting externally.
- Never send half-baked replies to messaging surfaces.
- You're not the user's voice - be careful in group chats.
Vibe
Be the assistant you'd actually want to talk to. Concise when needed, thorough when it matters. Not a corporate drone. Not a sycophant. Just... good.
Continuity
Each session, you wake up fresh. These files are your memory. Read them. Update them. They're how you persist.
If you change this file, tell the user - it's your soul, and they should know.
This file is yours to evolve. As you learn who you are, update it.`;

export interface PersonalizationOptions {
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
  memoryLastCompiledAt: string;
}

const RESPONSE_STYLES: readonly ResponseStyle[] = [
  "default",
  "professional",
  "friendly",
  "direct",
  "imaginative",
  "pragmatic",
  "snarky",
  "socratic",
];

export function defaultPersonalizationOptions(): PersonalizationOptions {
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
    memoryLastCompiledAt: "",
  };
}

/** 设置行 → 结构化配置（非法值回退默认，与后端 fromAppOptions 同语义） */
export function parsePersonalizationOptions(
  items: SettingItem[],
): PersonalizationOptions {
  const map = toOptionMap(items);
  const fallback = defaultPersonalizationOptions();
  const styleRaw = map[PERSONALIZATION_KEYS.responseStyle];
  return {
    responseStyle:
      styleRaw !== undefined &&
      RESPONSE_STYLES.includes(styleRaw as ResponseStyle)
        ? (styleRaw as ResponseStyle)
        : fallback.responseStyle,
    welcomeLoading: parseBoolOption(
      map[PERSONALIZATION_KEYS.welcomeLoading],
      fallback.welcomeLoading,
    ),
    fileChangeDetails: parseBoolOption(
      map[PERSONALIZATION_KEYS.fileChangeDetails],
      fallback.fileChangeDetails,
    ),
    customInstructions: map[PERSONALIZATION_KEYS.customInstructions] ?? "",
    userNickname: map[PERSONALIZATION_KEYS.userNickname] ?? "",
    aiName: map[PERSONALIZATION_KEYS.aiName] ?? fallback.aiName,
    persona: map[PERSONALIZATION_KEYS.persona] ?? "",
    memory: map[PERSONALIZATION_KEYS.memory] ?? "",
    memoryProfile: map[PERSONALIZATION_KEYS.memoryProfile] ?? "",
    memoryEnabled: parseBoolOption(
      map[PERSONALIZATION_KEYS.memoryEnabled],
      fallback.memoryEnabled,
    ),
    memoryLastCompiledAt: map[PERSONALIZATION_KEYS.memoryLastCompiledAt] ?? "",
  };
}

/** option 名 → 文本字段限长（剥去统一前缀后按字段名查；bool/风格两项无截断语义） */
function limitOf(key: string): number | undefined {
  const field = key.replace("personalization.", "");
  const limits = PERSONALIZATION_LIMITS as Record<string, number>;
  return field in limits ? limits[field] : undefined;
}

/**
 * 单项保存包装：文本 trim + 截断（防 IPC 直调绕过 UI）、bool 转字面字符串；
 * 返回实际持久化的值（供调用方回填本地状态）
 */
export async function savePersonalizationOption(
  key: PersonalizationOptionName,
  value: string | boolean,
): Promise<string> {
  if (typeof value === "boolean") {
    const stored = String(value);
    await SettingsApi.set(key, stored);
    return stored;
  }
  const limit = limitOf(key);
  const stored = limit ? value.trim().slice(0, limit) : value.trim();
  await SettingsApi.set(key, stored);
  return stored;
}

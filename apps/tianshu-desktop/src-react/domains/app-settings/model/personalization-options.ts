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
// 批9 P2.1：per-user key 单源（@tianshu/core——主进程 repo/前端同源；
// 渲染层禁裸引 barrel，走子路径——renderer-core-subpath-guard）
import {
  PERSONALIZATION_USER_FIELDS,
  personalizationUserKey,
} from "@tianshu/core/personalization-config";

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
  memoryModelId: "personalization.memoryModelId",
  memoryLastCompiledAt: "personalization.memoryLastCompiledAt",
  memoryLastError: "personalization.memoryLastError",
} as const;

/** 个性化 option 名联合（PERSONALIZATION_KEYS 的值；调用方传 PERSONALIZATION_KEYS.xxx） */
export type PersonalizationOptionName =
  (typeof PERSONALIZATION_KEYS)[keyof typeof PERSONALIZATION_KEYS];

/** 批9 P2.1 per-user key（画像三键随用户命名空间——与主进程同源） */
export {
  memoryProfileKeyFor,
  memoryLastCompiledAtKeyFor,
  memoryLastErrorKeyFor,
} from "@tianshu/core/personalization-config";

/** 文本字段限长（与后端一致） */
export const PERSONALIZATION_LIMITS = {
  customInstructions: 1500,
  userNickname: 20,
  aiName: 20,
  persona: 4000,
  memory: 1500,
  memoryProfile: MEMORY_PROFILE_LIMIT,
  /** 强指定记忆整理模型 id（model.id 十进制字符串；空 = 自动解析） */
  memoryModelId: 10,
  /** 上次整理时间（ISO 字符串，正常 24 字符，留余量防脏数据） */
  memoryLastCompiledAt: 40,
  /** 最近一次整理失败原因截断（修订 A：失败可观测） */
  memoryLastError: 200,
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
  /** 强指定记忆整理模型（model.id 字符串；空 = 自动解析候选序） */
  memoryModelId: string;
  memoryLastCompiledAt: string;
  memoryLastError: string;
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
    memoryModelId: "",
    memoryLastCompiledAt: "",
    memoryLastError: "",
  };
}

/**
 * 设置行 → 结构化配置（非法值回退默认，与后端 fromAppOptions 同语义）。
 * 批9 P2.1：userId 给定时画像三键优先读 `personalization.<userId>.*` 行，
 * 缺席回落旧全局行（与主进程 repo 迁移语义一致——升级读值连续）；
 * userId 缺省（未登录态）保持旧全局行解析
 */
export function parsePersonalizationOptions(
  items: SettingItem[],
  userId?: number,
): PersonalizationOptions {
  const map = toOptionMap(items);
  // per-user 行优先（仅画像三键；其余键恒全局）
  const userMap: Record<string, string | undefined> = {};
  if (userId !== undefined) {
    for (const field of PERSONALIZATION_USER_FIELDS) {
      const userKey = personalizationUserKey(userId, field);
      if (map[userKey] !== undefined) {
        userMap[PERSONALIZATION_KEYS[field]] = map[userKey];
      }
    }
  }
  const read = (key: string): string | undefined =>
    userMap[key] !== undefined ? userMap[key] : map[key];
  const fallback = defaultPersonalizationOptions();
  const styleRaw = read(PERSONALIZATION_KEYS.responseStyle);
  return {
    responseStyle:
      styleRaw !== undefined &&
      RESPONSE_STYLES.includes(styleRaw as ResponseStyle)
        ? (styleRaw as ResponseStyle)
        : fallback.responseStyle,
    welcomeLoading: parseBoolOption(
      read(PERSONALIZATION_KEYS.welcomeLoading),
      fallback.welcomeLoading,
    ),
    fileChangeDetails: parseBoolOption(
      read(PERSONALIZATION_KEYS.fileChangeDetails),
      fallback.fileChangeDetails,
    ),
    customInstructions: read(PERSONALIZATION_KEYS.customInstructions) ?? "",
    userNickname: read(PERSONALIZATION_KEYS.userNickname) ?? "",
    aiName: read(PERSONALIZATION_KEYS.aiName) ?? fallback.aiName,
    persona: read(PERSONALIZATION_KEYS.persona) ?? "",
    memory: read(PERSONALIZATION_KEYS.memory) ?? "",
    memoryProfile: read(PERSONALIZATION_KEYS.memoryProfile) ?? "",
    memoryEnabled: parseBoolOption(
      read(PERSONALIZATION_KEYS.memoryEnabled),
      fallback.memoryEnabled,
    ),
    memoryModelId: read(PERSONALIZATION_KEYS.memoryModelId) ?? "",
    memoryLastCompiledAt: read(PERSONALIZATION_KEYS.memoryLastCompiledAt) ?? "",
    memoryLastError: read(PERSONALIZATION_KEYS.memoryLastError) ?? "",
  };
}

/** option 名 → 文本字段限长（剥统一前缀与可选 per-user 命名空间段后按
 *  字段名查；bool/风格两项无截断语义——批9 兼容 personalization.<id>.x 键） */
function limitOf(key: string): number | undefined {
  const field = key.replace(/^personalization\.(?:\d+\.)?/, "");
  const limits = PERSONALIZATION_LIMITS as Record<string, number>;
  return field in limits ? limits[field] : undefined;
}

/**
 * 单项保存包装：文本 trim + 截断（防 IPC 直调绕过 UI）、bool 转字面字符串；
 * 返回实际持久化的值（供调用方回填本地状态）。key 接受 per-user 命名空间
 * 键（批9 画像写入走 memoryProfileKeyFor(userId)）
 */
export async function savePersonalizationOption(
  key: PersonalizationOptionName | string,
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

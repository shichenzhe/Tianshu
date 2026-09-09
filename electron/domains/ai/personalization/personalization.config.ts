/**
 * 个性化配置（option 表 type="app"）：类型、key 常量、默认值与解析。
 * 存储语义（spec §3）：行不存在 = 用默认值；存在 = 用存的值（含空串）。
 * persona 默认空 = 未启用不注入（spec D6：DEFAULT_PERSONA 仅预填编辑弹窗，
 * 该文案在前端 personalization-options.ts，主进程不持有）
 */
import { parseBoolOption } from "../../app-settings/option-store";

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
  memoryLastCompiledAt: "personalization.memoryLastCompiledAt",
} as const;

/** 文本字段限长（解析端截断，防 IPC 直调绕过 UI 的 maxLength） */
export const PERSONALIZATION_LIMITS = {
  customInstructions: 1500,
  userNickname: 20,
  aiName: 20,
  persona: 4000,
  memory: 1500,
  memoryProfile: 8000,
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
    memoryLastCompiledAt: "",
  };
}

/** 解析风格值：未知/缺失回退 default */
function parseStyle(raw: string | undefined): ResponseStyle {
  return raw !== undefined && RESPONSE_STYLES.includes(raw as ResponseStyle)
    ? (raw as ResponseStyle)
    : "default";
}

/** 取文本字段并截断到限长（缺失 = 默认值） */
function textValue(
  map: Map<string, string>,
  key: string,
  limit: number,
  fallback: string,
): string {
  return (map.get(key) ?? fallback).slice(0, limit);
}

/** option 行（name/value）→ 配置：缺失/非法值回退默认，超长截断 */
export function fromAppOptions(
  rows: Array<{ name: string; value: string }>,
): PersonalizationConfig {
  const map = new Map(rows.map((row) => [row.name, row.value]));
  const limit = PERSONALIZATION_LIMITS;
  const keys = PERSONALIZATION_KEYS;
  return {
    responseStyle: parseStyle(map.get(keys.responseStyle)),
    welcomeLoading: parseBoolOption(
      map.get(keys.welcomeLoading),
      defaultPersonalization().welcomeLoading,
    ),
    fileChangeDetails: parseBoolOption(
      map.get(keys.fileChangeDetails),
      defaultPersonalization().fileChangeDetails,
    ),
    customInstructions: textValue(
      map,
      keys.customInstructions,
      limit.customInstructions,
      "",
    ),
    userNickname: textValue(map, keys.userNickname, limit.userNickname, ""),
    aiName: textValue(map, keys.aiName, limit.aiName, "天枢"),
    persona: textValue(map, keys.persona, limit.persona, ""),
    memory: textValue(map, keys.memory, limit.memory, ""),
    memoryProfile: textValue(map, keys.memoryProfile, limit.memoryProfile, ""),
    memoryEnabled: parseBoolOption(
      map.get(keys.memoryEnabled),
      defaultPersonalization().memoryEnabled,
    ),
    memoryLastCompiledAt: textValue(map, keys.memoryLastCompiledAt, 40, ""),
  };
}

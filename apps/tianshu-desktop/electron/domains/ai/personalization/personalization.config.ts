/**
 * 个性化配置（option 表 type="app"）：类型、key 常量、默认值与解析。
 * 存储语义（spec §3）：行不存在 = 用默认值；存在 = 用存的值（含空串）。
 * persona 默认空 = 未启用不注入（spec D6：DEFAULT_PERSONA 仅预填编辑弹窗，
 * 该文案在前端 personalization-options.ts，主进程不持有）
 *
 * PL-1 拆分：纯常量段（ResponseStyle/PERSONALIZATION_KEYS/
 * PERSONALIZATION_LIMITS/PersonalizationConfig/defaultPersonalization）
 * 随 prompt.ts 闭包物理入 @tianshu/core
 * （packages/tianshu-core/src/personalization-config.ts），此处 re-export；
 * option 行 → 配置解析 fromAppOptions 为带 option-store 依赖
 * （parseBoolOption）的读段函数，留消费方不入包——server 读侧
 * （src/core/personalization.ts）对应段双份，drift manifest 守护。
 */
import { parseBoolOption } from "../../app-settings/option-store";
import {
  PERSONALIZATION_KEYS,
  PERSONALIZATION_LIMITS,
  defaultPersonalization,
  type PersonalizationConfig,
  type ResponseStyle,
} from "@tianshu/core";

export {
  PERSONALIZATION_KEYS,
  PERSONALIZATION_LIMITS,
  defaultPersonalization,
} from "@tianshu/core";
export type { PersonalizationConfig, ResponseStyle } from "@tianshu/core";

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
    memoryModelId: textValue(map, keys.memoryModelId, limit.memoryModelId, ""),
    memoryLastCompiledAt: textValue(
      map,
      keys.memoryLastCompiledAt,
      limit.memoryLastCompiledAt,
      "",
    ),
    memoryLastError: textValue(
      map,
      keys.memoryLastError,
      limit.memoryLastError,
      "",
    ),
  };
}

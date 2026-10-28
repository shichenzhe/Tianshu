/**
 * 个性化配置读取（PL-1，spec §2.1）：自 mirror
 * electron/domains/ai/personalization/personalization.repo.ts（读段）+
 * personalization.config.ts 的 fromAppOptions（解析段）语义逐字移植。
 * - 每次调用现查 option 表（type="app"），刻意不做缓存——设置修改对
 *   下一轮对话即刻生效（mirror spec D2）；
 * - 读取异常（库损坏等）→ 回退全默认 + 日志，绝不让设置问题打断对话；
 * - 纯常量（PERSONALIZATION_KEYS/LIMITS/defaultPersonalization）经
 *   @tianshu/core 包消费（与 mirror 同一份）；解析段为 mirror 双份
 *   （fromAppOptions 含 option-store 依赖不入包），drift manifest 守护；
 * - memory Profile 即编译产物（option 行 personalization.memoryProfile），
 *   读侧零额外表——无头端初始为空 = mirror 未配置时行为一致。
 */
import { Logger } from '@nestjs/common';
import {
  PERSONALIZATION_KEYS,
  PERSONALIZATION_LIMITS,
  defaultPersonalization,
  type PersonalizationConfig,
  type ResponseStyle,
} from '@tianshu/core';

const logger = new Logger('Personalization');

/** 设置项统一落在 option 表的 type 值（mirror option-store APP_OPTION_TYPE） */
const APP_OPTION_TYPE = 'app';

/** prisma option delegate 结构子集（真实客户端/测试 stub 均可注入） */
export interface OptionPrismaLike {
  findMany(args: {
    where: { type: string; name?: { in: string[] } };
    select: { name: true; value: true };
  }): Promise<Array<{ name: string; value: string }>>;
}

const RESPONSE_STYLES: readonly ResponseStyle[] = [
  'default',
  'professional',
  'friendly',
  'direct',
  'imaginative',
  'pragmatic',
  'snarky',
  'socratic',
];

/** 解析风格值：未知/缺失回退 default（mirror parseStyle 同语义） */
function parseStyle(raw: string | undefined): ResponseStyle {
  return raw !== undefined && RESPONSE_STYLES.includes(raw as ResponseStyle)
    ? (raw as ResponseStyle)
    : 'default';
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

/** 布尔解析（mirror option-store parseBoolOption 同语义）：仅字面 "true" 为真 */
function parseBoolOption(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) {
    return fallback;
  }
  return raw === 'true';
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
      '',
    ),
    userNickname: textValue(map, keys.userNickname, limit.userNickname, ''),
    aiName: textValue(map, keys.aiName, limit.aiName, '天枢'),
    persona: textValue(map, keys.persona, limit.persona, ''),
    memory: textValue(map, keys.memory, limit.memory, ''),
    memoryProfile: textValue(map, keys.memoryProfile, limit.memoryProfile, ''),
    memoryEnabled: parseBoolOption(
      map.get(keys.memoryEnabled),
      defaultPersonalization().memoryEnabled,
    ),
    memoryModelId: textValue(map, keys.memoryModelId, limit.memoryModelId, ''),
    memoryLastCompiledAt: textValue(
      map,
      keys.memoryLastCompiledAt,
      limit.memoryLastCompiledAt,
      '',
    ),
    memoryLastError: textValue(
      map,
      keys.memoryLastError,
      limit.memoryLastError,
      '',
    ),
  };
}

/**
 * 读取个性化配置（含 memory Profile 段数据）：现查不缓存，异常回退全默认
 * （chat-runner system 组装点每轮调用）
 */
export async function loadPersonalization(
  db: OptionPrismaLike,
): Promise<PersonalizationConfig> {
  try {
    const rows = await db.findMany({
      where: {
        type: APP_OPTION_TYPE,
        name: { in: Object.values(PERSONALIZATION_KEYS) },
      },
      select: { name: true, value: true },
    });
    return fromAppOptions(rows);
  } catch (error) {
    logger.warn(
      `个性化配置读取失败，回退默认: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return defaultPersonalization();
  }
}

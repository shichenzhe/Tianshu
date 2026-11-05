/**
 * 个性化配置读取（spec §4.1）：每次调用现查 option 表（同步 SQLite、微秒级），
 * 刻意不做缓存——设置修改对下一轮对话即刻生效（spec D2）。
 * 读取异常（库损坏/测试 stub 无 delegate）→ 回退全默认 + 日志，
 * 绝不让设置问题打断对话（spec §6）。
 *
 * 批9（2026-11-05）P2.1 userId 隔离：画像正文与整理元数据三键按
 * `personalization.<userId>.<field>` 命名空间拆行（key 单源 @tianshu/core
 * personalizationUserKey；其余键保持本机全局）。带 userId 读取时：
 * ① 旧全局行在场且新 key 缺席 → 首读搬入当前用户命名空间（升级不断忆），
 *   旧 key 行保留（兼容读取 + 回滚不断忆；迁移写失败仅日志不阻断读）；
 * ② 解析时 per-user 行优先，缺席回落旧全局行（与 ① 组合保证迁移前后
 *   读值连续）。
 * 注：fromAppOptions（drift 守护双份段）签名不动——key 翻译收敛在本层。
 */
import prisma from "../../../commons/prisma-client";
import Log from "../../../commons/Log";
import { getAppOptionMap, setAppOption } from "../../app-settings/option-store";
import {
  PERSONALIZATION_KEYS,
  PERSONALIZATION_USER_FIELDS,
  defaultPersonalization,
  fromAppOptions,
  personalizationUserKey,
  type PersonalizationConfig,
} from "./personalization.config";

/** 旧全局 key → 当前用户命名空间首读搬移（幂等：新 key 已在场不覆盖） */
async function migrateLegacyMemoryRows(
  userId: number,
  map: Map<string, string>,
): Promise<void> {
  for (const field of PERSONALIZATION_USER_FIELDS) {
    const userKey = personalizationUserKey(userId, field);
    const legacyKey = PERSONALIZATION_KEYS[field];
    if (map.has(userKey) || !map.has(legacyKey)) {
      continue;
    }
    const value = map.get(legacyKey) ?? "";
    try {
      await setAppOption(prisma.option, userKey, value);
      map.set(userKey, value); // 与落库态对齐（当次解析即用新行）
    } catch (error) {
      // 写失败不阻断读：解析侧仍回落旧全局行（对话不中断）
      Log.warn("记忆画像命名空间迁移写失败，回落旧全局 key 读取", error);
    }
  }
}

/** per-user 行优先的行集翻译：新行值写入同名全局键位（全局行缺席也补位，
 *  供 fromAppOptions 原样解析；新行缺席则保留全局行值=兼容回落） */
function preferUserRows(
  rows: Array<{ name: string; value: string }>,
  userId: number,
): Array<{ name: string; value: string }> {
  const byName = new Map(rows.map((row) => [row.name, row.value]));
  for (const field of PERSONALIZATION_USER_FIELDS) {
    const userValue = byName.get(personalizationUserKey(userId, field));
    if (userValue !== undefined) {
      byName.set(PERSONALIZATION_KEYS[field], userValue);
    }
  }
  return [...byName.entries()].map(([name, value]) => ({ name, value }));
}

export async function loadPersonalization(
  userId?: number,
): Promise<PersonalizationConfig> {
  try {
    const names: string[] = [...Object.values(PERSONALIZATION_KEYS)];
    if (userId !== undefined) {
      names.push(
        ...PERSONALIZATION_USER_FIELDS.map((field) =>
          personalizationUserKey(userId, field),
        ),
      );
    }
    const map = await getAppOptionMap(prisma.option, names);
    if (userId !== undefined) {
      await migrateLegacyMemoryRows(userId, map);
    }
    const rows = [...map.entries()].map(([name, value]) => ({ name, value }));
    return fromAppOptions(
      userId === undefined ? rows : preferUserRows(rows, userId),
    );
  } catch (error) {
    Log.warn("个性化配置读取失败，回退默认", error);
    return defaultPersonalization();
  }
}

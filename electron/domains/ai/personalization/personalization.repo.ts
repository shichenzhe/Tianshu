/**
 * 个性化配置读取（spec §4.1）：每次调用现查 option 表（同步 SQLite、微秒级），
 * 刻意不做缓存——设置修改对下一轮对话即刻生效（spec D2）。
 * 读取异常（库损坏/测试 stub 无 delegate）→ 回退全默认 + 日志，
 * 绝不让设置问题打断对话（spec §6）。
 */
import prisma from "../../../commons/prisma-client";
import Log from "../../../commons/Log";
import { getAppOptionMap } from "../../app-settings/option-store";
import {
  PERSONALIZATION_KEYS,
  defaultPersonalization,
  fromAppOptions,
  type PersonalizationConfig,
} from "./personalization.config";

export async function loadPersonalization(): Promise<PersonalizationConfig> {
  try {
    const names = Object.values(PERSONALIZATION_KEYS);
    const map = await getAppOptionMap(prisma.option, [...names]);
    return fromAppOptions(
      [...map.entries()].map(([name, value]) => ({ name, value })),
    );
  } catch (error) {
    Log.warn("个性化配置读取失败，回退默认", error);
    return defaultPersonalization();
  }
}

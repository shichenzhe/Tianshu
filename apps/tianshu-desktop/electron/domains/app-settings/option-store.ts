/**
 * app 设置项存取（option 表 type="app" 的最小读写层）。
 * 读写均为注入 prisma 的纯函数：settings 服务与后续 skill 自动化等
 * 系统行为流程共用；写为 upsert 语义（updateMany 命中 0 行则 create），
 * 与 option:update（仅 updateMany）互补。
 */

/** 设置项统一落在 option 表的 type 值 */
export const APP_OPTION_TYPE = "app";

/** 设置项名（option.name）登记处：新增设置项在此补充 */
export const OPTION_NAMES = {
  keepAwake: "keepAwake",
  proxyMode: "proxyMode",
  proxyHost: "proxyHost",
  proxyPort: "proxyPort",
  autoInstallTrustedSkills: "autoInstallTrustedSkills",
  autoUpdateSkills: "autoUpdateSkills",
} as const;

/** prisma option delegate 结构子集（真实客户端/测试 stub 均可注入） */
export interface OptionPrismaLike {
  findMany(args: {
    where: { type: string; name?: { in: string[] } };
    select: { name: true; value: true };
  }): Promise<Array<{ name: string; value: string }>>;
  updateMany(args: {
    where: { type: string; name: string };
    data: { value: string };
  }): Promise<{ count: number }>;
  create(args: {
    data: { type: string; name: string; value: string };
  }): Promise<unknown>;
}

/** type="app" 全部设置项（按返回行序） */
export async function listAppOptions(
  db: OptionPrismaLike,
): Promise<Array<{ name: string; value: string }>> {
  return db.findMany({
    where: { type: APP_OPTION_TYPE },
    select: { name: true, value: true },
  });
}

/** 按名取一批设置项（缺项不出现于结果） */
export async function getAppOptionMap(
  db: OptionPrismaLike,
  names: string[],
): Promise<Map<string, string>> {
  const rows = await db.findMany({
    where: { type: APP_OPTION_TYPE, name: { in: names } },
    select: { name: true, value: true },
  });
  return new Map(rows.map((row) => [row.name, row.value]));
}

/** upsert：先 updateMany（type+name 定位），命中 0 行则 create */
export async function setAppOption(
  db: OptionPrismaLike,
  name: string,
  value: string,
): Promise<void> {
  const result = await db.updateMany({
    where: { type: APP_OPTION_TYPE, name },
    data: { value },
  });
  if (result.count === 0) {
    await db.create({ data: { type: APP_OPTION_TYPE, name, value } });
  }
}

/** 布尔设置项解析：仅字面 "true" 为真，缺省回退 fallback（畸形值视为关） */
export function parseBoolOption(
  raw: string | undefined,
  fallback: boolean,
): boolean {
  if (raw === undefined) {
    return fallback;
  }
  return raw === "true";
}

/** skill 自动化开关（安全默认全关；消费点接入前仅持久化） */
export interface SkillAutomationFlags {
  autoInstallTrusted: boolean;
  autoUpdate: boolean;
}

/** 读 skill 自动化开关：autoInstallTrustedSkills / autoUpdateSkills，缺省 false */
export async function readSkillAutomationFlags(
  db: OptionPrismaLike,
): Promise<SkillAutomationFlags> {
  const map = await getAppOptionMap(db, [
    OPTION_NAMES.autoInstallTrustedSkills,
    OPTION_NAMES.autoUpdateSkills,
  ]);
  return {
    autoInstallTrusted: parseBoolOption(
      map.get(OPTION_NAMES.autoInstallTrustedSkills),
      false,
    ),
    autoUpdate: parseBoolOption(map.get(OPTION_NAMES.autoUpdateSkills), false),
  };
}

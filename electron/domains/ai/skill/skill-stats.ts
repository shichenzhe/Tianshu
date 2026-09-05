/**
 * 技能埋点(P-E spec §2):事件流采集 + 聚合纯函数。
 * recordSkillEvent 供五个写入点 fire-and-forget 调用(调用方不 await):
 * catch + Log.warn 吞错 —— 埋点属可观测性,失败绝不影响主流程;
 * delegate 缺席(纯函数测试/独立形态)静默跳过,保持 installer/
 * create-skill 可选依赖的可测性。aggregateSkillStats 供 skill:stats
 * IPC 全量行内存聚合(本地单机事件量级千级,决策 4)。
 */
import Log from "../../../commons/Log";

export type SkillStatEvent =
  | "install"
  | "create"
  | "enable"
  | "disable"
  | "uninstall"
  | "batch_enable"
  | "batch_disable"
  | "batch_uninstall";

/** 事件行(prisma skillStat findMany 结果的结构子集) */
export interface SkillStatRow {
  name: string;
  event: string;
  createdAt: Date;
}

export interface SkillStatItem {
  name: string;
  installs: number;
  creates: number;
  enables: number;
  disables: number;
  uninstalls: number;
  batchOps: number;
  lastActiveAt: Date;
}

/** prisma skillStat delegate 结构子集(注入 stub/真实客户端均可) */
export interface SkillStatPrismaLike {
  create(args: { data: { name: string; event: string } }): Promise<unknown>;
}

type SkillStatCounterKey = keyof Omit<SkillStatItem, "name" | "lastActiveAt">;

/** 事件 → 计数分桶(批量三种事件合计 batchOps;未知事件 null = 忽略) */
function counterKey(event: string): SkillStatCounterKey | null {
  switch (event) {
    case "install":
      return "installs";
    case "create":
      return "creates";
    case "enable":
      return "enables";
    case "disable":
      return "disables";
    case "uninstall":
      return "uninstalls";
    case "batch_enable":
    case "batch_disable":
    case "batch_uninstall":
      return "batchOps";
    default:
      return null;
  }
}

function emptyItem(name: string, createdAt: Date): SkillStatItem {
  return {
    name,
    installs: 0,
    creates: 0,
    enables: 0,
    disables: 0,
    uninstalls: 0,
    batchOps: 0,
    lastActiveAt: createdAt,
  };
}

/** 埋点写入:swallow 错误(catch + Log.warn);delegate 缺席静默跳过 */
export async function recordSkillEvent(
  prisma: SkillStatPrismaLike | undefined,
  name: string,
  event: SkillStatEvent,
): Promise<void> {
  if (!prisma) {
    return;
  }
  try {
    await prisma.create({ data: { name, event } });
  } catch (e) {
    Log.warn("技能埋点写入失败", `${name}:${event}`, e);
  }
}

/** 事件行 → 按技能聚合(name 升序;未知事件忽略;lastActiveAt 取最大 createdAt) */
export function aggregateSkillStats(rows: SkillStatRow[]): SkillStatItem[] {
  const byName = new Map<string, SkillStatItem>();
  for (const row of rows) {
    const key = counterKey(row.event);
    if (!key) {
      continue;
    }
    const item = byName.get(row.name) ?? emptyItem(row.name, row.createdAt);
    item[key] += 1;
    if (row.createdAt > item.lastActiveAt) {
      item.lastActiveAt = row.createdAt;
    }
    byName.set(row.name, item);
  }
  return [...byName.values()].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
}

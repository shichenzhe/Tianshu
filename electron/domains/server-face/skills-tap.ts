// A3 技能批（spec 2026-10-26 §1.3）：桌面被控面技能管理扩展桥——
// skills/query 契约增量（scenarios/source/builtin 可选段，协议
// SkillBriefExtension 与 RemoteSkillBrief 交集消费，既有消费方不受影响）；
// setScenarios 场景三值打标 / uninstall 卸载（builtin 拒 SKILL_BUILTIN，
// skillsDir 边界守卫复用 repo 现有删除守卫）。仓储单实例 Application 注入。
// A3 尾：installUpload base64 zip 直装（≤3MB，复用 repo 持有 installer——
// 严禁 face 侧 new）；stats skillStat 事件表聚合（repo.stats groupBy 下推）。
import { SKILL_SCENARIOS } from "@tianshu/protocol";
import type {
  RemoteSkillBrief,
  SkillBriefExtension,
  SkillErrorCode,
  SkillScenario,
  SkillStatItem,
} from "@tianshu/protocol";
import type { SkillRepository } from "../ai/skill/skill.repo";
import type { ServerFaceSkills } from "./deps";

/** relay 单帧 4MiB 余量（同 files/uploadImage 3MB 口径，spec §6 假设 1） */
const UPLOAD_MAX_BYTES = 3 * 1024 * 1024;

/** 技能面业务错（code 稳定——routes 侧转 bizError 信封，控制端判码） */
export class FaceSkillError extends Error {
  readonly code: SkillErrorCode;
  constructor(code: SkillErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** 桥接的仓储方法子集（SkillRepository 满足） */
export type SkillsRepoSubset = Pick<
  SkillRepository,
  | "list"
  | "readSkill"
  | "setEnabled"
  | "setScenarios"
  | "uninstall"
  | "stats"
  | "installFromUpload"
>;

/** 场景三值校验：白名单过滤（与桌面 repo 同口径防脏数据），顺序去重 */
function validScenarios(raw: SkillScenario[]): SkillScenario[] {
  const allowed = new Set<string>(SKILL_SCENARIOS);
  return [...new Set(raw.filter((s) => allowed.has(s)))];
}

/** 埋点聚合行 → 协议统计项：usedCount = 全部事件计数合计（install/create/
 *  enable/disable/uninstall/batch_*），lastUsedAt = 最新事件 ISO */
function toStatItem(row: {
  name: string;
  installs: number;
  creates: number;
  enables: number;
  disables: number;
  uninstalls: number;
  batchOps: number;
  lastActiveAt: Date;
}): SkillStatItem {
  return {
    name: row.name,
    usedCount:
      row.installs +
      row.creates +
      row.enables +
      row.disables +
      row.uninstalls +
      row.batchOps,
    lastUsedAt: row.lastActiveAt.toISOString(),
  };
}

export function createSkillsFace(repo: SkillsRepoSubset): ServerFaceSkills {
  return {
    list: async () => {
      // 本地 skill:list 自愈对账返回 skillRecord 行（含 enabled/scenarios/
      // source——增量扩展段直透，既有三字段消费方不受影响）
      const rows = await repo.list();
      return rows.map((row): RemoteSkillBrief & SkillBriefExtension => ({
        name: row.name,
        ...(row.description != null ? { description: row.description } : {}),
        enabled: row.enabled,
        ...(row.scenarios !== null
          ? { scenarios: row.scenarios as SkillScenario[] }
          : {}),
        source: row.source,
        builtin: row.source === "builtin",
      }));
    },
    read: (_userId, name) => repo.readSkill(name),
    setEnabled: (_userId, name, enabled) => repo.setEnabled(name, enabled),
    setScenarios: async (_userId, name, scenarios) => {
      try {
        await repo.setScenarios(name, validScenarios(scenarios));
      } catch (error) {
        if (error instanceof Error && error.message === "SKILL_NOT_FOUND") {
          throw new FaceSkillError("SKILL_NOT_FOUND", "技能不存在");
        }
        throw error;
      }
    },
    uninstall: async (_userId, name) => {
      try {
        await repo.uninstall(name);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("系统内置")) {
          throw new FaceSkillError("SKILL_BUILTIN", "内置技能不支持卸载");
        }
        throw error;
      }
    },
    // A3 尾：base64 解码（≤3MB）→ repo 持有 installer buffer 直装
    // （source=local 与桌面 zip 导入同语义——冲突 {status:"conflict"} 透传，
    // 控制端确认覆写后带 overwrite=true 二次请求；坏 zip/包结构不合法等
    // 安装错误收 SKILL_UPLOAD_INVALID）
    installUpload: async (_userId, payload) => {
      const buf = Buffer.from(payload.base64, "base64");
      if (buf.length > UPLOAD_MAX_BYTES) {
        throw new FaceSkillError("SKILL_UPLOAD_INVALID", "zip 超过 3MB 上限");
      }
      try {
        return await repo.installFromUpload(buf, payload.overwrite === true);
      } catch (error) {
        throw new FaceSkillError(
          "SKILL_UPLOAD_INVALID",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    // A3 尾：skillStat 事件表聚合（repo.stats SQL groupBy 下推，M12）
    stats: async (_userId) => {
      const { items } = await repo.stats();
      return items.map(toStatItem);
    },
  };
}

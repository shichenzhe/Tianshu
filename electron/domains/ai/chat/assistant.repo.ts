/**
 * 助手预设仓储（专家 2.0）：IPC + 落库 + 专家 JSON 导入/导出。
 * 模块顶层保持零重依赖副作用——prisma-client 与 tool-registry 的顶层
 * import 会在模块加载期触发 electron app 初始化（prisma-client 直接用
 * app.getPath、tool-registry 经 network-gate→Log 用），纯函数直测
 * （tests/ai/expert-io.test.ts，无 mock 三件套）即崩：prisma 改惰性
 * 单例，专家工具注册改构造器内异步一拍（registry 消费方均在 chat
 * 发送/automation 运行期读取，晚一拍微任务时序安全）；dialog 亦按
 * showOpenDialog/showSaveDialog 先例（skill.repo）在方法内惰性 import。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { handleUser } from "../../../commons/ipc-user";
import {
  makeCreateExpertTool,
  makeUpdateExpertTool,
  teamMemberSchema,
  validateTeamMembers,
} from "../agent/create-expert";
import { makeRecommendExpertTool } from "../agent/recommend-expert-tool";
import { parseJsonStringArray } from "./expert-catalog";
import { parseTeamMembers, type TeamMember } from "./expert-team";
import type {
  AssistantCreateParams,
  AssistantRecord,
  AssistantUpdateParams,
} from "../../../../src-react/domains/ai/api/assistant.api";

type PrismaClientLike =
  (typeof import("../../../commons/prisma-client"))["default"];

type AssistantRow = NonNullable<
  Awaited<ReturnType<PrismaClientLike["assistant"]["findFirst"]>>
>;

/** prisma 惰性单例（首次调用才加载 prisma-client 及其 electron 依赖链） */
let prismaPromise: Promise<PrismaClientLike> | undefined;

function prismaClient(): Promise<PrismaClientLike> {
  prismaPromise ??= import("../../../commons/prisma-client").then(
    (m) => m.default,
  );
  return prismaPromise;
}

/** 专家导出 JSON 固定形状（zod）：kind/version 魔术标识 + 10 个内容字段
 *  （8 基础 + 专家团 expertType/members；成员校验复用工具侧同一 schema
 *  与集合校验函数——DRY 单源） */
export const expertExportSchema = z
  .object({
    kind: z.literal("tianshu-expert"),
    version: z.literal(1),
    name: z.string().min(1),
    systemPrompt: z.string().min(1),
    icon: z.string().optional(),
    description: z.string().optional(),
    profession: z.string().optional(),
    categoryId: z.string().optional(),
    tags: z.array(z.string()).max(3).optional(),
    quickPrompts: z.array(z.string()).max(3).optional(),
    skillNames: z.array(z.string()).max(3).optional(),
    expertType: z.enum(["agent", "team"]).optional(),
    members: z.array(teamMemberSchema).optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.members) {
      return;
    }
    // 集合级规则（≤13、id 团内唯一）与 create_expert 校验链同一函数
    const reason = validateTeamMembers(data.members);
    if (reason) {
      ctx.addIssue({ code: "custom", message: reason, path: ["members"] });
    }
  });

export type ExpertExportJson = z.infer<typeof expertExportSchema>;

export type ExpertParseResult =
  { ok: true; data: ExpertExportJson } | { ok: false; reason: string };

/**
 * 序列化为导出 JSON：剔除 id/builtin/sourceSlug/时间戳（归属与内置标识
 * 不随文件走），空数组不落键；可选字段缺省（undefined）不落键。专家团
 * 字段（expertType/members）随 team 记录导出（toRecord 归一后 expertType
 * 仅 "team"，agent 记录两键均缺省不落——导入回读不降级）
 */
export function serializeExpert(record: AssistantRecord): ExpertExportJson {
  return {
    kind: "tianshu-expert",
    version: 1,
    name: record.name,
    ...(record.icon !== undefined ? { icon: record.icon } : {}),
    systemPrompt: record.systemPrompt,
    ...(record.description !== undefined
      ? { description: record.description }
      : {}),
    ...(record.profession !== undefined
      ? { profession: record.profession }
      : {}),
    ...(record.categoryId !== undefined
      ? { categoryId: record.categoryId }
      : {}),
    ...(record.tags?.length ? { tags: record.tags } : {}),
    ...(record.quickPrompts?.length
      ? { quickPrompts: record.quickPrompts }
      : {}),
    ...(record.skillNames?.length ? { skillNames: record.skillNames } : {}),
    ...(record.expertType !== undefined
      ? { expertType: record.expertType }
      : {}),
    ...(record.members?.length ? { members: record.members } : {}),
  };
}

/** 解析导出 JSON：坏 JSON / 结构不符（缺 name、kind 不符等）拒绝并给原因 */
export function parseExpertJson(raw: string): ExpertParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "不是合法的 JSON 文件" };
  }
  const parsed = expertExportSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `专家文件格式不正确: ${parsed.error.issues[0]?.message ?? "结构错误"}`,
    };
  }
  return { ok: true, data: parsed.data };
}

/**
 * 重名后缀（纯函数）：命中 `${name}-2`、`-3` 递增至不冲突；
 * nameExists 为查重闭包（DB findFirst 封装由调用方注入）
 */
export async function dedupeName(
  name: string,
  nameExists: (candidate: string) => Promise<boolean>,
): Promise<string> {
  let finalName = name;
  let suffix = 2;
  while (await nameExists(finalName)) {
    finalName = `${name}-${suffix}`;
    suffix += 1;
  }
  return finalName;
}

/**
 * members 载荷校验（收口 T5-I2）：结构逐员过 teamMemberSchema、集合规则过
 * validateTeamMembers——与 create/update_expert 工具、专家导入 schema 同一
 * 函数单源（复用 create-expert 导出，expert-team 保持零依赖不引入 zod）；
 * 失败抛中文错误（非错误码白名单，前端 mapIpcError 兜底原样显示）
 */
function assertMembersValid(members: TeamMember[]): void {
  for (const member of members) {
    const parsed = teamMemberSchema.safeParse(member);
    if (!parsed.success) {
      throw new Error(
        `专家团成员不合法: ${parsed.error.issues[0]?.message ?? "结构错误"}`,
      );
    }
  }
  const reason = validateTeamMembers(members);
  if (reason) {
    throw new Error(`专家团成员不合法: ${reason}`);
  }
}

export class AssistantRepository {
  /**
   * @param deps 专家工具装配（专家 2.0）：listInstalledNames 注入
   * skillRepo 的已安装技能名清单（本 repo 不持有 skillRepo 实例，避免与
   * 技能域构造耦合，由 Application 装配）；缺席（测试）按空清单保守过滤
   */
  constructor(deps?: { listInstalledNames?: () => Promise<string[]> }) {
    this.listInstalledNames = deps?.listInstalledNames;
    this.registerIpcHandlers();
    // create/update_expert + recommend_experts 工具注册进聚合 registry
    // （skill.repo 同款先例）；注册所经模块惰性加载（见文件头注释）
    void this.registerExpertTools();
  }

  /** 已安装技能名清单（装配注入；专家工具与导入共用的过滤依据） */
  private readonly listInstalledNames?: () => Promise<string[]>;

  private async registerExpertTools(): Promise<void> {
    try {
      const [{ registerTools }, prisma] = await Promise.all([
        import("../agent/tool-registry"),
        prismaClient(),
      ]);
      // 技能名过滤经注入的已安装清单，装配在 Application 启动序
      const listInstalledSkillNames = async (): Promise<string[]> =>
        (await this.listInstalledNames?.()) ?? [];
      registerTools([
        makeCreateExpertTool({
          prisma: prisma.assistant,
          listInstalledSkillNames,
        }),
        makeUpdateExpertTool({
          prisma: prisma.assistant,
          listInstalledSkillNames,
        }),
        // recommend_experts：未绑专家会话的专家推荐卡（渲染层消费 args、
        // 无落库副作用 → read 免审批，无 deps 纯函数，show_widget 先例）
        makeRecommendExpertTool(),
      ]);
    } catch (e) {
      const { default: Log } = await import("../../../commons/Log");
      Log.error("专家工具注册失败", e);
    }
  }

  private toRecord(row: AssistantRow): AssistantRecord {
    return {
      ...row,
      icon: row.icon ?? undefined,
      temperature: row.temperature ?? undefined,
      topP: row.topP ?? undefined,
      maxTokens: row.maxTokens ?? undefined,
      description: row.description ?? undefined,
      // JSON 数组字符串列（tags/quickPrompts/skillNames）共享解析
      //（坏数据回退空数组，expert-catalog 导出避免双份实现）
      tags: parseJsonStringArray(row.tags),
      sourceSlug: row.sourceSlug ?? undefined,
      profession: row.profession ?? undefined,
      categoryId: row.categoryId ?? undefined,
      quickPrompts: parseJsonStringArray(row.quickPrompts),
      skillNames: parseJsonStringArray(row.skillNames),
      // 专家团列：expertType 仅 "team" 透传（agent 为默认语义归一 undefined），
      // members 对象数组解析（坏数据回退 []，expert-team 唯一实现）
      expertType: row.expertType === "team" ? "team" : undefined,
      members: parseTeamMembers(row.members),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private registerIpcHandlers() {
    handleUser("assistant:list", (_, userId) => this.list(userId));
    handleUser("assistant:create", (_, userId, p: AssistantCreateParams) =>
      this.create(p, userId),
    );
    handleUser("assistant:update", (_, userId, p: AssistantUpdateParams) =>
      this.update(p, userId),
    );
    handleUser("assistant:delete", (_, userId, id: number) =>
      this.delete(id, userId),
    );
    handleUser("assistant:export", (_, userId, id: number) =>
      this.exportToFile(id, userId),
    );
    handleUser("assistant:import", (_, userId) => this.importFromFile(userId));
  }

  /** 校验助手归当前用户并取回行（不存在与他人所有同报错，不泄露存在性；
   *  delete/exportToFile 复用同一查询，收敛内联拷贝） */
  private async requireOwned(
    id: number,
    userId: number,
  ): Promise<AssistantRow> {
    const prisma = await prismaClient();
    const row = await prisma.assistant.findFirst({ where: { id, userId } });
    if (!row) {
      throw new Error("ASSISTANT_NOT_FOUND");
    }
    return row;
  }

  async list(userId: number): Promise<AssistantRecord[]> {
    const prisma = await prismaClient();
    return (
      await prisma.assistant.findMany({
        where: { userId },
        orderBy: [{ builtin: "desc" }, { createdAt: "asc" }],
      })
    ).map((row) => this.toRecord(row));
  }

  async getById(id: number): Promise<AssistantRecord | null> {
    const prisma = await prismaClient();
    const row = await prisma.assistant.findUnique({ where: { id } });
    return row ? this.toRecord(row) : null;
  }

  /** 被控面（A2 批）归属校验读：id+userId 双条件，不存在/他人所有同 null
   *  （不泄露存在性）；detail/save 守卫经此收口 */
  async getOwned(id: number, userId: number): Promise<AssistantRecord | null> {
    const prisma = await prismaClient();
    const row = await prisma.assistant.findFirst({ where: { id, userId } });
    return row ? this.toRecord(row) : null;
  }

  async create(
    p: AssistantCreateParams,
    userId: number,
  ): Promise<AssistantRecord> {
    // IPC 直写通道（表单/市场/导入）的成员校验（T5-I2）：与工具链同 schema
    if (p.members) {
      assertMembersValid(p.members);
    }
    const prisma = await prismaClient();
    const row = await prisma.assistant.create({
      data: {
        name: p.name,
        icon: p.icon,
        systemPrompt: p.systemPrompt,
        temperature: p.temperature,
        topP: p.topP,
        maxTokens: p.maxTokens,
        description: p.description,
        tags: p.tags ? JSON.stringify(p.tags) : undefined,
        sourceSlug: p.sourceSlug,
        profession: p.profession,
        categoryId: p.categoryId,
        quickPrompts: p.quickPrompts
          ? JSON.stringify(p.quickPrompts)
          : undefined,
        skillNames: p.skillNames ? JSON.stringify(p.skillNames) : undefined,
        // agent 归一不写列：与 create_expert 工具侧同口径（列契约只存 "team"|NULL，
        // schema v1 注释），repo IPC（表单/导入）是最后一个未归一写入方
        expertType: p.expertType === "agent" ? undefined : p.expertType,
        members: p.members ? JSON.stringify(p.members) : undefined,
        userId,
      },
    });
    return this.toRecord(row);
  }

  async update(
    p: AssistantUpdateParams,
    userId: number,
  ): Promise<AssistantRecord> {
    // 差量载荷带成员数组即校验（null=清空语义不经此链，T5-I2）
    if (p.members) {
      assertMembersValid(p.members);
    }
    await this.requireOwned(p.id, userId);
    const prisma = await prismaClient();
    const row = await prisma.assistant.update({
      where: { id: p.id },
      data: {
        name: p.name,
        icon: p.icon,
        systemPrompt: p.systemPrompt,
        temperature: p.temperature,
        topP: p.topP,
        maxTokens: p.maxTokens,
        description: p.description,
        // 可空字段 undefined 时键整体不出现在 data（区别于 null = 清空）
        ...(p.tags === undefined
          ? {}
          : { tags: p.tags === null ? null : JSON.stringify(p.tags) }),
        ...(p.profession === undefined ? {} : { profession: p.profession }),
        ...(p.categoryId === undefined ? {} : { categoryId: p.categoryId }),
        ...(p.quickPrompts === undefined
          ? {}
          : {
              quickPrompts:
                p.quickPrompts === null ? null : JSON.stringify(p.quickPrompts),
            }),
        ...(p.skillNames === undefined
          ? {}
          : {
              skillNames:
                p.skillNames === null ? null : JSON.stringify(p.skillNames),
            }),
        ...(p.sourceSlug === undefined ? {} : { sourceSlug: p.sourceSlug }),
        // expertType 三态：undefined 不动列；显式 "agent" = team 转回单专家的
        // 清列通道（归一 null，与工具侧 T4 裁定 2 同口径）；"team" 写列
        ...(p.expertType === undefined
          ? {}
          : { expertType: p.expertType === "agent" ? null : p.expertType }),
        ...(p.members === undefined
          ? {}
          : { members: p.members === null ? null : JSON.stringify(p.members) }),
      },
    });
    return this.toRecord(row);
  }

  async delete(id: number, userId: number): Promise<void> {
    const row = await this.requireOwned(id, userId);
    if (row.builtin) {
      // 错误码由渲染端 mapIpcError 映射 i18n 文案
      throw new Error("ASSISTANT_BUILTIN");
    }
    const prisma = await prismaClient();
    await prisma.assistant.delete({ where: { id } });
  }

  /** 导出专家为 JSON 文件：另存对话框 + 写盘；用户取消返回 null */
  async exportToFile(id: number, userId: number): Promise<string | null> {
    const record = this.toRecord(await this.requireOwned(id, userId));
    const { dialog } = await import("electron");
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: "导出专家",
      defaultPath: `${record.name}.expert.json`,
      filters: [{ name: "Expert JSON", extensions: ["json"] }],
    });
    if (canceled || !filePath) {
      return null;
    }
    writeFileSync(
      filePath,
      JSON.stringify(serializeExpert(record), null, 2),
      "utf8",
    );
    return filePath;
  }

  /** 导入专家 JSON：单选文件 → 校验 → 重名后缀 → skillNames 过滤已安装 → 落库 */
  async importFromFile(userId: number): Promise<{ name: string } | null> {
    const data = await this.pickExpertFile();
    if (!data) {
      return null; // 用户取消，渲染端静默
    }
    const created = await this.importFromJson(data, userId);
    return { name: created.name };
  }

  /** 导入专家 JSON 内容（被控面 A2 尾与文件导入共用语义——抽出内容面供
   *  expert-tap 复用，免对话框）：重名后缀 → skillNames 过滤已安装 →
   *  create 落库（members 随团 JSON 透传，create 内同 schema 校验） */
  async importFromJson(
    data: ExpertExportJson,
    userId: number,
  ): Promise<AssistantRecord> {
    const prisma = await prismaClient();
    return this.create(
      {
        // 重名后缀（dedupeName 纯函数）：查重闭包封装 DB findFirst
        name: await dedupeName(
          data.name,
          async (candidate) =>
            (await prisma.assistant.findFirst({
              where: { name: candidate, userId },
            })) !== null,
        ),
        systemPrompt: data.systemPrompt,
        icon: data.icon,
        description: data.description,
        profession: data.profession,
        categoryId: data.categoryId,
        tags: data.tags,
        quickPrompts: data.quickPrompts,
        // 专家团字段随文件导入（schema 已同校验），不再静默降级为单专家
        expertType: data.expertType,
        members: data.members,
        // sourceSlug 不带（导入的是自定义专家）；技能仅保留已安装
        ...(await this.filterImportableSkills(data)),
      },
      userId,
    );
  }

  /** 文件选择 + 解析：取消返回 null；格式不符抛错（渲染端 toast 原因） */
  private async pickExpertFile(): Promise<ExpertExportJson | null> {
    const { dialog } = await import("electron");
    const res = await dialog.showOpenDialog({
      title: "导入专家",
      properties: ["openFile"],
      filters: [{ name: "Expert JSON", extensions: ["json"] }],
    });
    const filePath = res.canceled ? undefined : res.filePaths[0];
    if (!filePath) {
      return null;
    }
    const parsed = parseExpertJson(readFileSync(filePath, "utf8"));
    if (!parsed.ok) {
      throw new Error(parsed.reason);
    }
    return parsed.data;
  }

  /** 导入技能过滤：剔除未安装技能名（与 create_expert 工具同口径） */
  private async filterImportableSkills(
    data: ExpertExportJson,
  ): Promise<{ skillNames?: string[] }> {
    const installed = new Set((await this.listInstalledNames?.()) ?? []);
    const skillNames = (data.skillNames ?? []).filter((name) =>
      installed.has(name),
    );
    return skillNames.length > 0 ? { skillNames } : {};
  }
}

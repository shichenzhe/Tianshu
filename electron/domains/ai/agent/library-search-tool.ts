/**
 * library_search 内置工具（2026-11-01 审查余项⑨，桌面工具化）：chat
 * 模型检索用户资料库——此前桌面模型无资料库检索面（仅图节点与用户手动
 * @ 两条路；server 有 PL-2 向量版但 library 集合无写入方恒空）。
 *
 * 检索形态裁定：关键词文件名检索（LibraryRepository.search 同款查询：
 * kind=file + name contains，keyword 截 100——立即可用零新依赖；向量
 * 语义版等 server「library 写入批」落地后两端再统一）。纯 Node 实现
 * （禁止 import electron），vitest 直测（widget/read-skill 先例）。
 */
import { z } from "zod";
import prisma from "../../../commons/prisma-client";
import type { ToolDefinition } from "./file-tools";

export const LIBRARY_SEARCH_TOOL_NAME = "library_search";

/** 默认返回条数（个人库量级小；@ 引用列表可读性优先） */
const DEFAULT_LIMIT = 10;

/** 空结果文案（导出供测试断言；语义如实不炸不伪造） */
export const LIBRARY_SEARCH_EMPTY = "资料库无命中条目";

const argsSchema = z.object({
  keyword: z.string().min(1).describe("检索关键词（文件名包含匹配）"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe("返回条数，缺省 10"),
});

export type LibrarySearchArgs = z.infer<typeof argsSchema>;

export function makeLibrarySearchTool(): ToolDefinition<LibrarySearchArgs> {
  return {
    name: LIBRARY_SEARCH_TOOL_NAME,
    description:
      "检索用户资料库条目（按文件名关键词匹配，返回条目号/名称/类型/大小" +
      "与更新时间）；命中后如需读取文件内容，请提示用户在输入框 @ 该文件" +
      "引用（引用将注入文件全文）",
    parameters: argsSchema,
    kind: "read",
    execute: async (ctx, { keyword, limit }) => {
      const userId = ctx.userId ?? 0;
      const trimmed = keyword.trim().slice(0, 100);
      if (!trimmed) {
        return LIBRARY_SEARCH_EMPTY;
      }
      const rows = await prisma.libraryItem.findMany({
        where: {
          kind: "file",
          name: { contains: trimmed },
          userId,
        },
        orderBy: { updatedAt: "desc" },
        take: limit ?? DEFAULT_LIMIT,
      });
      if (rows.length === 0) {
        return LIBRARY_SEARCH_EMPTY;
      }
      const lines = rows.map(
        (row) =>
          `- 条目 #${row.id}｜${row.name}（${row.mimeType ?? "未知类型"}${
            row.size != null ? `，${Math.max(1, Math.round(row.size / 1024))}KB` : ""
          }，更新于 ${row.updatedAt.toISOString().slice(0, 10)}）`,
      );
      return `资料库命中 ${rows.length} 条：\n${lines.join("\n")}`;
    },
  };
}

/**
 * library 条目查找（文件窗 T14）：后端无单条 IPC，library:tree 全量平铺
 * 前端 find id——LibraryTabBody（条目元数据/基线）与 use-file-session
 * （会话标题/授权 storagePath）共同消费。
 */
import LibraryApi, {
  type LibraryItem,
} from "@/domains/ai/library/api/library.api";

export async function libraryItemOf(
  itemId: number,
): Promise<LibraryItem | null> {
  const items = (await LibraryApi.tree()) as LibraryItem[];
  return items.find((x) => x.id === itemId) ?? null;
}

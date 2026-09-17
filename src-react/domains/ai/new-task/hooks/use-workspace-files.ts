/**
 * 工作空间文件清单（@ 联想面板与 AttachMenu 引用子面板共用数据源）：
 * 直连 invoke 拉取（调用形态对齐 ChatInput.tsx:240），按 workspaceId 缓存，
 * 同一空间激活期内只拉一次（空间切换重拉）。不走 react-query——落地页测试
 * 对 @tanstack/react-query 整模块打桩（useQuery 恒返空数组，数据须经
 * invoke mock 注入，见 tests/ai/new-task-input-card.test.tsx）。
 * 未加载完成返回 null；未绑定目录后端返回 null → 收敛为空清单。
 */
import { useEffect, useState } from "react";

import { invoke } from "@/lib/ipc";

export function useWorkspaceFiles(
  workspaceId: number | null,
  active: boolean,
): string[] | null {
  const [cache, setCache] = useState<{ id: number; files: string[] } | null>(
    null,
  );

  useEffect(() => {
    if (
      !active ||
      workspaceId === null ||
      (cache && cache.id === workspaceId)
    ) {
      return;
    }
    let cancelled = false;
    invoke<string[] | null>("file:listWorkspaceFiles", workspaceId)
      .then((files) => {
        if (!cancelled) {
          setCache({ id: workspaceId, files: files ?? [] });
        }
      })
      .catch(() => {
        // 拉取失败按空清单收敛（面板提示无匹配，不阻断输入）
        if (!cancelled) {
          setCache({ id: workspaceId, files: [] });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [active, workspaceId, cache]);

  return cache && cache.id === workspaceId ? cache.files : null;
}

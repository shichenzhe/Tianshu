/**
 * 本地文件引用入列（选择器/拖拽共用）：readExternalFile 校验通过
 * （≤512KB、非二进制、有权限）才进 pending pill（路径引用不拷贝，内容
 * 发送时按 ref 再读）；图片附件跳过预检（多模态通道不受 512KB 文本上限，
 * 主进程侧 10MB 校验兜底）；失败按 isOversizeError 区分 oversize/
 * readFailed toast 一次并跳过该文件
 */
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { isImagePath } from "../../chat/lib/image-file";
import { isOversizeError, pathTail, readExternalFile } from "../lib/attach";
import { useNewTaskStore } from "../store/new-task-store";

export function useLocalFileAttach(): (absPath: string) => Promise<void> {
  const { t } = useTranslation(["newTask"]);
  const addPending = useNewTaskStore((s) => s.addPending);
  return useCallback(
    async (absPath: string) => {
      if (!isImagePath(absPath)) {
        try {
          await readExternalFile(absPath);
        } catch (error) {
          toast.error(
            t(
              isOversizeError(error)
                ? "newTask:attach.oversize"
                : "newTask:attach.readFailed",
            ),
          );
          return;
        }
      }
      addPending({ label: pathTail(absPath), ref: absPath, kind: "localFile" });
    },
    [t, addPending],
  );
}

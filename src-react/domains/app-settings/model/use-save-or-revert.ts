/**
 * 设置保存反馈 hook（三组共用）：保存 Promise 失败时回滚视觉态并 toast。
 * 开关类控件为乐观更新——勾选即改本地态，此处兜底失败场景。
 */

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

export function useSaveOrRevert() {
  const { t } = useTranslation(["settings"]);

  return useCallback(
    (save: Promise<void>, revert: () => void) => {
      save.catch(() => {
        revert();
        toast.error(t("settings:error.saveFailed"));
      });
    },
    [t],
  );
}

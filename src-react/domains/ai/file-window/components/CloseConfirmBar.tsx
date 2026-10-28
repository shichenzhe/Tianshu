/**
 * 关闭确认条（close-request 逐 dirty tab 确认，spec §4.4）：视图层自绘
 * 轻量确认浮层——保存并关闭（调注册表保存流后关 tab）/放弃（直接关）/
 * 取消（cancelClose）；{title} 插值文件名。按钮落子经 onAnswer 回抛，
 * 状态机（confirmingTabId）在 FileWindowView。
 */
import { useTranslation } from "react-i18next";
import type { FileWindowTab } from "../store/file-window.store";

export type CloseConfirmAnswer = "save" | "discard" | "cancel";

const BTN =
  "rounded border border-border/50 px-2 py-1 text-xs hover:bg-primary-subtle hover:text-primary hover:border-primary/30";

export default function CloseConfirmBar({
  tab,
  onAnswer,
}: {
  tab: FileWindowTab;
  onAnswer: (answer: CloseConfirmAnswer) => void;
}) {
  const { t } = useTranslation(["chat"]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-background px-4 py-3 shadow-lg">
        <span className="text-sm">
          {t("chat:fileWindow.closeConfirm.title", { title: tab.title })}
        </span>
        <button type="button" className={BTN} onClick={() => onAnswer("save")}>
          {t("chat:fileWindow.closeConfirm.saveAndClose")}
        </button>
        <button
          type="button"
          className={BTN}
          onClick={() => onAnswer("discard")}
        >
          {t("chat:fileWindow.closeConfirm.discard")}
        </button>
        <button
          type="button"
          className={BTN}
          onClick={() => onAnswer("cancel")}
        >
          {t("chat:fileWindow.closeConfirm.cancel")}
        </button>
      </div>
    </div>
  );
}

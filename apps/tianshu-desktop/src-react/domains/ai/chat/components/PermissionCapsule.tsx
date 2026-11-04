/**
 * 权限胶囊（P3）：二档单选面板（2026-10-24 权限放宽批文案基准）
 * 二档语义：default=高危询问（文件写入/常用命令直执行，删除等敏感操作先
 * 询问）、full=免责+极高危命令（如磁盘抹除、强推主干）仍确认；
 * 选 default 直接回落，选 full 先弹 FullAccessModal 强制免责确认——确认才
 * 切换，取消保持原档；权限态由 ChatPane 持有（受控），本组件不落库
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronUp, ShieldCheck, Unlock } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import FullAccessModal from "./FullAccessModal";

export type AccessMode = "default" | "full";

interface ModeOption {
  value: AccessMode;
  titleKey: string;
  descKey: string;
  Icon: LucideIcon;
}

/** 二档单选清单：default 高危询问 / full 完全访问（文案见 chat:permission.*） */
const MODE_OPTIONS: ModeOption[] = [
  {
    value: "default",
    titleKey: "chat:permission.default",
    descKey: "chat:permission.descDefault",
    Icon: ShieldCheck,
  },
  {
    value: "full",
    titleKey: "chat:permission.full",
    descKey: "chat:permission.descFull",
    Icon: Unlock,
  },
];

interface PermissionCapsuleProps {
  /** 兼容 ChatInput 传参保留（单选面板无开关，不再需要无障碍 id） */
  sessionId?: number;
  accessMode: AccessMode;
  onChange: (mode: AccessMode) => void;
}

export default function PermissionCapsule({
  accessMode,
  onChange,
}: PermissionCapsuleProps) {
  const { t } = useTranslation(["chat"]);
  const [modalOpen, setModalOpen] = useState(false);
  const isFull = accessMode === "full";

  // default 直切回落；full 须经 FullAccessModal 免责确认才切换
  const handleSelect = (mode: AccessMode) => {
    if (mode === "full") {
      setModalOpen(true);
      return;
    }
    onChange("default");
  };

  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-border/50 px-2.5 text-xs hover:border-primary/30 hover:bg-primary-subtle"
            aria-label={t("chat:permission.modeSelector")}
          >
            {isFull ? (
              <Unlock className="h-3.5 w-3.5 text-primary" />
            ) : (
              <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />
            )}
            <span className={isFull ? "text-primary" : "text-muted-foreground"}>
              {isFull
                ? t("chat:permission.full")
                : t("chat:permission.default")}
            </span>
            <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          className="w-72 border border-border/50 rounded-lg shadow-lg"
        >
          <p className="text-xs font-medium text-foreground">
            {t("chat:permission.modeSelector")}
          </p>
          <div className="mt-1.5 space-y-1">
            {MODE_OPTIONS.map(({ value, titleKey, descKey, Icon }) => (
              <button
                key={value}
                type="button"
                aria-pressed={accessMode === value}
                onClick={() => handleSelect(value)}
                className="flex w-full items-start gap-2.5 rounded-md p-2 text-left hover:bg-primary-subtle"
              >
                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium text-foreground">
                    {t(titleKey)}
                  </span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                    {t(descKey)}
                  </span>
                </span>
                {accessMode === value && (
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                )}
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
      <FullAccessModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        onConfirm={() => onChange("full")}
      />
    </>
  );
}

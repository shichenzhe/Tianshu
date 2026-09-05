/**
 * 权限胶囊（P3）：点击上弹面板展示当前权限态与「允许完全访问」开关
 * 开 → 弹 FullAccessModal 强制确认（不直接切换）；关 → 无确认直接回落默认权限；
 * 权限态由 ChatPane 持有（受控），本组件不落库
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronUp, ShieldCheck, Unlock } from "lucide-react";

import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import FullAccessModal from "./FullAccessModal";

export type AccessMode = "default" | "full";

interface PermissionCapsuleProps {
  /** 仅用于生成无障碍 id；权限读写均在 ChatPane */
  sessionId: number;
  accessMode: AccessMode;
  onChange: (mode: AccessMode) => void;
}

export default function PermissionCapsule({
  sessionId,
  accessMode,
  onChange,
}: PermissionCapsuleProps) {
  const { t } = useTranslation(["chat"]);
  const [modalOpen, setModalOpen] = useState(false);
  const isFull = accessMode === "full";
  const switchId = `permission-full-${sessionId}`;

  const handleSwitchChange = (checked: boolean) => {
    if (checked) {
      setModalOpen(true);
    } else {
      onChange("default");
    }
  };

  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-border/50 px-2.5 text-xs hover:border-primary/30 hover:bg-primary-subtle"
            aria-label={t("chat:permission.allowFullAccess")}
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
          className="w-64 border border-border/50 rounded-lg shadow-lg"
        >
          <p className="text-xs leading-relaxed text-muted-foreground">
            {isFull
              ? t("chat:permission.panelFullDesc")
              : t("chat:permission.panelDefaultDesc")}
          </p>
          <div className="mt-3 flex items-center gap-2">
            <Switch
              id={switchId}
              checked={isFull}
              onCheckedChange={handleSwitchChange}
            />
            <Label htmlFor={switchId} className="cursor-pointer">
              {t("chat:permission.allowFullAccess")}
            </Label>
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

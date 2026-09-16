/**
 * 沙箱安全卡片：总开关 + 四个二级入口（命令 SP2、文件 SP3、网络 SP5、运行时工具 SP6）
 */
import { useTranslation } from "react-i18next";
import {
  ChevronRight,
  FileLock,
  Globe,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { SecurityConfig, SecurityConfigKey } from "../model/types";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

interface SandboxCardProps {
  config: SecurityConfig;
  onToggle: (key: SecurityConfigKey, value: unknown) => void;
  onOpenCommand: () => void;
  onOpenFile: () => void;
  onOpenNetwork: () => void;
  onOpenRuntime: () => void;
}

const ENTRIES: {
  icon: LucideIcon;
  labelKey: string;
  descKey: string;
  /** 入口对应视图：四个二级入口均已启用 */
  view: "command" | "file" | "network" | "runtime";
}[] = [
  {
    icon: FileLock,
    labelKey: "security:sandbox.file",
    descKey: "security:sandbox.fileDesc",
    view: "file",
  },
  {
    icon: SquareTerminal,
    labelKey: "security:sandbox.command",
    descKey: "security:sandbox.commandDesc",
    view: "command",
  },
  {
    icon: Globe,
    labelKey: "security:sandbox.network",
    descKey: "security:sandbox.networkDesc",
    view: "network",
  },
  {
    icon: Wrench,
    labelKey: "security:sandbox.runtime",
    descKey: "security:sandbox.runtimeDesc",
    view: "runtime",
  },
];

export default function SandboxCard({
  config,
  onToggle,
  onOpenCommand,
  onOpenFile,
  onOpenNetwork,
  onOpenRuntime,
}: SandboxCardProps) {
  const { t } = useTranslation(["security"]);
  const openers: Record<
    "command" | "file" | "network" | "runtime",
    () => void
  > = {
    command: onOpenCommand,
    file: onOpenFile,
    network: onOpenNetwork,
    runtime: onOpenRuntime,
  };
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label className="text-sm font-normal">
            {t("security:sandbox.enabled")}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t("security:sandbox.enabledDesc")}
          </p>
        </div>
        <Switch
          aria-label={t("security:sandbox.enabled")}
          checked={config.sandboxEnabled}
          onCheckedChange={(checked) => onToggle("sandboxEnabled", checked)}
        />
      </div>
      <div className="space-y-1">
        {ENTRIES.map(({ icon: Icon, labelKey, descKey, view }) => (
          <button
            key={labelKey}
            type="button"
            onClick={openers[view]}
            className="flex w-full cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-primary-subtle hover:text-primary"
          >
            <Icon size={16} className="shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="text-sm">{t(labelKey)}</p>
              <p className="truncate text-xs text-muted-foreground">
                {t(descKey)}
              </p>
            </div>
            <ChevronRight size={14} className="text-muted-foreground" />
          </button>
        ))}
      </div>
    </div>
  );
}

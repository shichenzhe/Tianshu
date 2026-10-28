/**
 * 设置面板通用开关行：左侧标题 + 说明文案，右侧 Switch
 * 行布局与常规组控件同款视觉语言；勾选即时生效（乐观更新由调用方处理）
 */

import { useTranslation } from "react-i18next";

import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

interface SettingSwitchRowProps {
  /** 行标题 i18n key（渲染文本同时作为 Switch 可访问名称） */
  label: string;
  /** 说明文案 i18n key */
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

export default function SettingSwitchRow({
  label,
  description,
  checked,
  onCheckedChange,
}: SettingSwitchRowProps) {
  const { t } = useTranslation(["settings"]);

  return (
    <div className="flex items-center justify-between gap-4">
      <div className="space-y-0.5">
        <Label className="text-sm font-normal">{t(label)}</Label>
        <p className="text-xs text-muted-foreground">{t(description)}</p>
      </div>
      <Switch
        aria-label={t(label)}
        checked={checked}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}

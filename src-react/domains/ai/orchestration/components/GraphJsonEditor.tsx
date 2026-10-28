// src-react/domains/ai/orchestration/components/GraphJsonEditor.tsx
/**
 * JSON 源码模式编辑器（spec §7）：受控 textarea（等宽紧凑），不做校验
 * 只透传——解析/校验统一走父层共用出口（结构化 ⇄ JSON 双向同步的另一半）。
 */
import { useTranslation } from "react-i18next";

import { Textarea } from "@/components/ui/textarea";

export interface GraphJsonEditorProps {
  value: string;
  onChange: (raw: string) => void;
}

export default function GraphJsonEditor({
  value,
  onChange,
}: GraphJsonEditorProps) {
  const { t } = useTranslation(["chat"]);
  return (
    <Textarea
      className="h-full min-h-[420px] flex-1 resize-none rounded-lg border-border/50 font-mono text-xs leading-relaxed"
      aria-label={t("chat:orchestration.editor.modeJson")}
      spellCheck={false}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

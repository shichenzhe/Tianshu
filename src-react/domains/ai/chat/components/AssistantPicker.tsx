/**
 * 助手选择器：会话级助手预设切换，首项为「不使用助手」（null）
 */
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import AssistantApi from "../../api/assistant.api";
import SessionApi from "../../api/session.api";

const ASSISTANTS_KEY = ["assistants"] as const;
const SESSIONS_KEY = ["sessions"] as const;
const NONE_VALUE = "none";

interface AssistantPickerProps {
  sessionId: number;
  currentAssistantId?: number;
}

export default function AssistantPicker({
  sessionId,
  currentAssistantId,
}: AssistantPickerProps) {
  const { t } = useTranslation(["chat"]);
  const queryClient = useQueryClient();

  const assistantsQuery = useQuery({
    queryKey: ASSISTANTS_KEY,
    queryFn: () => AssistantApi.list(),
  });
  const assistants = assistantsQuery.data ?? [];

  const handleSelect = async (value: string) => {
    try {
      await SessionApi.setAssistant(
        sessionId,
        value === NONE_VALUE ? null : Number(value),
      );
      await queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Select
      value={
        currentAssistantId === undefined
          ? NONE_VALUE
          : String(currentAssistantId)
      }
      onValueChange={(value) => void handleSelect(value)}
    >
      <SelectTrigger className="h-8 w-32 shrink-0 rounded-md text-sm hover:bg-primary-subtle hover:text-primary hover:border-primary/30">
        <SelectValue placeholder={t("chat:input.selectAssistant")} />
      </SelectTrigger>
      <SelectContent className="border border-border/50 rounded-lg shadow-lg">
        <SelectItem value={NONE_VALUE}>
          {t("chat:input.noAssistant")}
        </SelectItem>
        {assistants.map((assistant) => (
          <SelectItem key={assistant.id} value={String(assistant.id)}>
            {assistant.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

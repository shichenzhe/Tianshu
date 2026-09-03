/**
 * 模型选择器：按服务商分组的下拉菜单，选中即写入会话当前模型
 */
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ProviderApi } from "../../api/provider.api";
import ModelApi from "../../api/model.api";
import SessionApi from "../../api/session.api";
import { mapIpcError } from "../lib/error-message";

const PROVIDERS_KEY = ["providers"] as const;
const MODELS_KEY = ["models"] as const;
const SESSIONS_KEY = ["sessions"] as const;

interface ModelPickerProps {
  sessionId: number;
  currentModelId?: number;
}

export default function ModelPicker({
  sessionId,
  currentModelId,
}: ModelPickerProps) {
  const { t } = useTranslation(["chat"]);
  const queryClient = useQueryClient();

  const providersQuery = useQuery({
    queryKey: PROVIDERS_KEY,
    queryFn: () => ProviderApi.list(),
  });
  const modelsQuery = useQuery({
    queryKey: MODELS_KEY,
    queryFn: () => ModelApi.listAll(),
  });

  const groups = useMemo(() => {
    const providers = providersQuery.data ?? [];
    const models = (modelsQuery.data ?? []).filter((model) => model.enabled);
    return providers
      .map((provider) => ({
        provider,
        models: models.filter((model) => model.providerId === provider.id),
      }))
      .filter((group) => group.models.length > 0);
  }, [providersQuery.data, modelsQuery.data]);

  const currentModel = (modelsQuery.data ?? []).find(
    (model) => model.id === currentModelId,
  );
  const currentLabel = currentModel
    ? currentModel.name || currentModel.modelId
    : t("chat:input.selectModel");

  const handleSelect = async (modelId: number) => {
    try {
      await SessionApi.setModel(sessionId, modelId);
      await queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={groups.length === 0}
          className="max-w-44 shrink-0 hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
          title={currentModel?.modelId}
        >
          <span className="truncate">{currentLabel}</span>
          <ChevronDown className="ml-1 h-4 w-4 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-72 w-56 overflow-y-auto border border-border/50 rounded-lg shadow-lg"
      >
        {groups.map((group, index) => (
          <div key={group.provider.id}>
            {index > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel>{group.provider.name}</DropdownMenuLabel>
            {group.models.map((model) => (
              <DropdownMenuItem
                key={model.id}
                onClick={() => void handleSelect(model.id)}
              >
                <span className="truncate" title={model.modelId}>
                  {model.name || model.modelId}
                </span>
                {model.id === currentModelId && (
                  <Check className="ml-auto h-4 w-4 shrink-0 text-primary" />
                )}
              </DropdownMenuItem>
            ))}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

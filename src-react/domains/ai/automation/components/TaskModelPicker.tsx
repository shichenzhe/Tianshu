/**
 * 任务模型选择器:ModelPicker 的无会话态变体——同款 providers/models
 * 分组视觉,受控 props(不写会话 IPC),保留「配置模型」跳转。
 */
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Check, ChevronDown, Server } from "lucide-react";

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

const PROVIDERS_ROUTE = "/module/ai/providers";

export interface TaskModelPickerProps {
  modelId?: number;
  onChange: (modelId: number) => void;
}

export default function TaskModelPicker({
  modelId,
  onChange,
}: TaskModelPickerProps) {
  const { t } = useTranslation(["chat"]);
  const navigate = useNavigate();

  const providersQuery = useQuery({
    queryKey: ["providers"],
    queryFn: () => ProviderApi.list(),
  });
  const modelsQuery = useQuery({
    queryKey: ["models", "all"],
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

  const currentModel = (modelsQuery.data ?? []).find((m) => m.id === modelId);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="max-w-44 shrink-0 border-0 hover:bg-primary-subtle hover:text-primary"
          title={currentModel?.modelId}
        >
          <span className="truncate">
            {currentModel
              ? currentModel.name || currentModel.modelId
              : t("chat:input.selectModel")}
          </span>
          <ChevronDown className="ml-1 h-4 w-4 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-72 w-56 overflow-y-auto border border-border/50 rounded-lg shadow-lg"
      >
        {groups.length === 0 && (
          <DropdownMenuLabel>{t("chat:input.modelRequired")}</DropdownMenuLabel>
        )}
        {groups.map((group, index) => (
          <div key={group.provider.id}>
            {index > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel>{group.provider.name}</DropdownMenuLabel>
            {group.models.map((model) => (
              <DropdownMenuItem
                key={model.id}
                onClick={() => onChange(model.id)}
              >
                <span className="truncate" title={model.modelId}>
                  {model.name || model.modelId}
                </span>
                {model.id === modelId && (
                  <Check className="ml-auto h-4 w-4 shrink-0 text-primary" />
                )}
              </DropdownMenuItem>
            ))}
          </div>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => navigate(PROVIDERS_ROUTE)}>
          <Server />
          {t("chat:settings.configureModels")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

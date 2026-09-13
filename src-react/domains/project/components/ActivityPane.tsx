/**
 * 项目动态流（spec §6.3）：providers/models 双空 → 简版服务商引导卡
 * （照 ChatView.SetupGuide 形态，跳 /module/ai/providers）；否则复用
 * ChatPane 渲染项目动态流会话，已挂载专家/技能作为输入过滤集下发
 * （仅 valid 项——失效挂载源已删，不进入输入可选集）。
 */
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Settings2 } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ProviderApi } from "@/domains/ai/api/provider.api";
import { ModelApi } from "@/domains/ai/api/model.api";
import { WorkspaceApi } from "@/domains/ai/api/workspace.api";
import ChatPane from "@/domains/ai/chat/components/ChatPane";
import type { ProjectDetail } from "../../../../electron/domains/project/project.entity";

const PROVIDERS_ROUTE = "/module/ai/providers";
const EXPERTS_ROUTE = "/module/ai/experts";
const CONNECTORS_ROUTE = "/module/ai/experts?tab=connectors";

interface ActivityPaneProps {
  detail: ProjectDetail;
}

export default function ActivityPane({ detail }: ActivityPaneProps) {
  const navigate = useNavigate();

  const providersQuery = useQuery({
    queryKey: ["providers"],
    queryFn: () => ProviderApi.list(),
  });
  const modelsQuery = useQuery({
    queryKey: ["models"],
    queryFn: () => ModelApi.listAll(),
  });
  const workspacesQuery = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => WorkspaceApi.list(),
  });

  const providers = providersQuery.data ?? [];
  const models = modelsQuery.data ?? [];
  // 双查询都成功返回且为空才引导（避免加载/出错期间误判，同 ChatView）
  const needsSetup =
    providersQuery.isSuccess &&
    modelsQuery.isSuccess &&
    providers.length === 0 &&
    models.length === 0;

  if (needsSetup) {
    return <SetupGuide onGoSetup={() => navigate(PROVIDERS_ROUTE)} />;
  }

  const workspace =
    (workspacesQuery.data ?? []).find(
      (entry) => entry.id === detail.session.workspaceId,
    ) ?? null;

  return (
    <ChatPane
      key={detail.session.id}
      session={detail.session}
      workspace={workspace}
      hasModel={Boolean(
        detail.session.currentModelId ?? workspace?.defaultModelId,
      )}
      onOpenSettings={(target) =>
        navigate(
          target === "providers"
            ? PROVIDERS_ROUTE
            : target === "mcp"
              ? CONNECTORS_ROUTE
              : EXPERTS_ROUTE,
        )
      }
      boundAssistantIds={detail.bindings
        .filter((b) => b.itemType === "assistant" && b.valid)
        .map((b) => b.itemId)}
      boundSkillNames={detail.bindings
        .filter((b) => b.itemType === "skill" && b.valid)
        .map((b) => b.itemName)}
    />
  );
}

interface SetupGuideProps {
  onGoSetup: () => void;
}

/** 简版服务商引导卡（形态同 ChatView.SetupGuide，项目模块内联实现） */
function SetupGuide({ onGoSetup }: SetupGuideProps) {
  const { t } = useTranslation(["chat"]);

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <Card className="w-full max-w-md border-border/50 rounded-lg shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Settings2 className="h-5 w-5 text-primary" />
            {t("chat:setupProviders")}
          </CardTitle>
          <CardDescription>{t("chat:setupProvidersTip")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={onGoSetup} className="hover:bg-primary-hover">
            {t("chat:goSetup")}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

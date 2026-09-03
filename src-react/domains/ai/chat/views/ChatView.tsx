/**
 * AI 对话主界面：左侧会话侧边栏 + 右侧消息区/输入区
 * （消息区与输入区为占位，分别由后续任务替换为消息列表与输入组件）
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Settings2 } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ProviderApi } from "../../api/provider.api";
import { ModelApi } from "../../api/model.api";
import SessionSidebar from "../components/SessionSidebar";
import MessageList from "../components/MessageList";

const PROVIDERS_KEY = ["providers"] as const;
const MODELS_KEY = ["models"] as const;
const PROVIDERS_ROUTE = "/module/ai/providers";

export default function ChatView() {
  const navigate = useNavigate();
  const [selectedSessionId, setSelectedSessionId] = useState<number | null>(
    null,
  );

  const providersQuery = useQuery({
    queryKey: PROVIDERS_KEY,
    queryFn: () => ProviderApi.list(),
  });
  const modelsQuery = useQuery({
    queryKey: MODELS_KEY,
    queryFn: () => ModelApi.listAll(),
  });

  const providers = providersQuery.data ?? [];
  const models = modelsQuery.data ?? [];
  // 两个查询都成功返回且为空，才展示服务商引导（避免加载/出错期间误判）
  const needsSetup =
    providersQuery.isSuccess &&
    modelsQuery.isSuccess &&
    providers.length === 0 &&
    models.length === 0;

  return (
    <div className="flex h-full">
      <SessionSidebar
        selectedSessionId={selectedSessionId}
        onSelectSession={setSelectedSessionId}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        {needsSetup ? (
          <SetupGuide onGoSetup={() => navigate(PROVIDERS_ROUTE)} />
        ) : (
          <>
            {/* 消息区：历史 + 流式渲染（重新生成按钮待 Task 17 接线 onRegenerate） */}
            <MessageList sessionId={selectedSessionId} />
            {/* 输入区占位：Task 17 替换为输入组件 */}
            <div
              data-testid="chat-input"
              className="border-t border-border/50 p-4"
            />
          </>
        )}
      </div>
    </div>
  );
}

interface SetupGuideProps {
  onGoSetup: () => void;
}

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

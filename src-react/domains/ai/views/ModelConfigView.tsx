/**
 * AI 模型配置页（可选模块）
 * 管理模型配置 + ai:chat 调用测试
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Bot, Send } from "lucide-react";

import PageTitle from "@/components/layout/PageTitle";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import ModelConfigDialog from "../components/ModelConfigDialog";
import AIApi from "../api/ai.api";

export default function ModelConfigView() {
  const { t } = useTranslation(["ai"]);
  const [managerOpen, setManagerOpen] = useState(false);
  const [testInput, setTestInput] = useState("");
  const [testing, setTesting] = useState(false);

  const runChatTest = async () => {
    if (!testInput.trim() || testing) return;
    setTesting(true);
    try {
      const result = await AIApi.chat({ content: testInput.trim() });
      if (result) {
        toast.success(t("ai:chatTestSuccess"), {
          description: result.slice(0, 200),
        });
      } else {
        toast.warning(t("ai:chatTestEmpty"));
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="p-6">
      <PageTitle title={t("ai:pageTitle")}>
        <Button
          className="hover:bg-primary-hover"
          onClick={() => setManagerOpen(true)}
        >
          <Bot className="w-4 h-4 mr-2" />
          {t("ai:openManager")}
        </Button>
      </PageTitle>
      <p className="text-sm text-muted-foreground mb-6 max-w-2xl">
        {t("ai:pageDesc")}
      </p>

      <div className="max-w-2xl space-y-3">
        <h3 className="text-sm font-medium text-foreground">
          {t("ai:chatTestTitle")}
        </h3>
        <Textarea
          value={testInput}
          onChange={(e) => setTestInput(e.target.value)}
          placeholder={t("ai:chatTestPlaceholder")}
          rows={3}
        />
        <Button
          onClick={runChatTest}
          disabled={!testInput.trim() || testing}
          className="hover:bg-primary-hover"
        >
          <Send className="w-4 h-4 mr-2" />
          {testing ? t("ai:chatTestRunning") : t("ai:chatTestRun")}
        </Button>
      </div>

      <ModelConfigDialog open={managerOpen} onOpenChange={setManagerOpen} />
    </div>
  );
}

/**
 * 专家·技能·连接器统一管理：Tab 切换（专家=助手预设 / 技能=技能管理 / 连接器=MCP）
 * 专家与连接器 Tab 复用既有设置视图；技能 Tab 挂 SkillsView（P-B 双视图）
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Bot, Plug, Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";
import AssistantSettingsView from "../../assistant/views/AssistantSettingsView";
import McpSettingsView from "../../mcp/views/McpSettingsView";
import SkillsView from "../../skills/views/SkillsView";

type ExpertTab = "assistants" | "skills" | "connectors";

export default function ExpertsView() {
  const { t } = useTranslation(["chat", "common"]);
  const [tab, setTab] = useState<ExpertTab>("assistants");

  const tabs: Array<{
    value: ExpertTab;
    icon: React.ReactNode;
    label: string;
  }> = [
    {
      value: "assistants",
      icon: <Bot className="h-4 w-4" />,
      label: t("chat:experts.tabAssistants"),
    },
    {
      value: "skills",
      icon: <Sparkles className="h-4 w-4" />,
      label: t("chat:experts.tabSkills"),
    },
    {
      value: "connectors",
      icon: <Plug className="h-4 w-4" />,
      label: t("chat:experts.tabConnectors"),
    },
  ];

  return (
    <div className="flex h-full flex-col overflow-y-auto p-4">
      <div className="mb-3 flex items-center gap-1 border-b border-border/50">
        {tabs.map((item) => (
          <button
            key={item.value}
            type="button"
            className={cn(
              "flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors",
              tab === item.value
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setTab(item.value)}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </div>
      {tab === "assistants" && <AssistantSettingsView />}
      {tab === "skills" && <SkillsView />}
      {tab === "connectors" && <McpSettingsView />}
    </div>
  );
}

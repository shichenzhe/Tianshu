/**
 * 专家·技能·连接器统一管理：Tab 切换（专家=助手预设 / 技能=技能管理 / 连接器=MCP）
 * 专家与连接器 Tab 复用既有设置视图；技能 Tab 挂 SkillsView（P-B 双视图）；
 * Tab 行迁入顶栏（TopBar 中段 pill 组），页面内容相应上移
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { Bot, Plug, Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";
import { usePageHeader } from "@/components/layout/page-header.store";
import AssistantSettingsView from "../../assistant/views/AssistantSettingsView";
import McpSettingsView from "../../mcp/views/McpSettingsView";
import SkillsView from "../../skills/views/SkillsView";

type ExpertTab = "assistants" | "skills" | "connectors";

export default function ExpertsView() {
  const { t } = useTranslation(["chat", "common"]);
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<ExpertTab>("assistants");
  // 入口直达：?tab=skills|connectors|assistants（挂载与变化都切换）
  const tabParam = searchParams.get("tab");
  useEffect(() => {
    if (
      tabParam === "skills" ||
      tabParam === "connectors" ||
      tabParam === "assistants"
    ) {
      setTab(tabParam);
    }
  }, [tabParam]);
  // 技能子视图直达：?view=installed（key 变化强制重挂载消费 initialView）
  const viewParam = searchParams.get("view");

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

  // Tab 行迁入顶栏（TopBar 中段，44px 行高改 pill 风格），内容相应上移
  usePageHeader({
    title: (
      <div className="inline-flex items-center rounded-lg border border-border/50 bg-primary-subtle/30 p-0.5 text-sm">
        {tabs.map((item) => (
          <button
            key={item.value}
            type="button"
            className={cn(
              "flex items-center gap-1.5 rounded-md px-3 py-1 transition-colors",
              tab === item.value
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-primary",
            )}
            onClick={() => setTab(item.value)}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </div>
    ),
  });

  return (
    <div className="flex h-full flex-col overflow-y-auto p-4">
      {tab === "assistants" && <AssistantSettingsView />}
      {tab === "skills" && (
        <SkillsView
          key={viewParam ?? "discover"}
          initialView={viewParam === "installed" ? "installed" : "discover"}
        />
      )}
      {tab === "connectors" && <McpSettingsView />}
    </div>
  );
}

/**
 * 推荐胶囊栏（spec §5）：场景预设模板 + 该场景已打标已启用技能混排；
 * 横向滚动隐藏滚动条（SkillDiscoverView:251 同款样式）
 */
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Sparkles, Zap } from "lucide-react";

import SkillApi from "../../skills/api/skill.api";
import { SCENARIO_CHIPS, filterScenarioSkills } from "../lib/scenario";
import { useNewTaskStore } from "../store/new-task-store";

interface PromptChipsProps {
  /**
   * 模板胶囊点击回调（filled = 已插值的模板文案）：由 NewTaskView 填 store
   * 并聚焦置光标（spec §5 光标落 [主题] 占位处）；缺省直接填 store（独立
   * 渲染兼容，同原行为）
   */
  onTemplateClick?: (filled: string) => void;
}

export default function PromptChips({ onTemplateClick }: PromptChipsProps) {
  const { t } = useTranslation(["newTask"]);
  const scenario = useNewTaskStore((s) => s.scenario);
  const setContent = useNewTaskStore((s) => s.setContent);
  const addPending = useNewTaskStore((s) => s.addPending);

  const applyTemplate = (chipKey: string) => {
    const filled = t(`newTask:chips.${chipKey}.prompt`);
    if (onTemplateClick) {
      onTemplateClick(filled);
    } else {
      setContent(filled);
    }
  };

  const skillsQuery = useQuery({
    queryKey: ["skillRecords"],
    queryFn: () => SkillApi.list(),
    staleTime: 60_000,
  });
  const scenarioSkills = filterScenarioSkills(skillsQuery.data ?? [], scenario);

  return (
    <div
      data-testid="prompt-chips"
      className="flex items-center gap-1.5 overflow-x-auto pb-1 [&::-webkit-scrollbar]:hidden"
    >
      {SCENARIO_CHIPS[scenario].map((chipKey) => (
        <button
          key={chipKey}
          type="button"
          onClick={() => applyTemplate(chipKey)}
          className="flex h-8 shrink-0 items-center gap-1 rounded-full border border-border/50 px-3 text-xs text-foreground hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
        >
          <Sparkles className="h-3 w-3 shrink-0 text-primary" />
          {t(`newTask:chips.${chipKey}.label`)}
        </button>
      ))}
      {scenarioSkills.map((skill) => (
        <button
          key={skill.name}
          type="button"
          title={skill.description ?? skill.name}
          onClick={() =>
            addPending({ label: skill.name, ref: skill.name, kind: "skill" })
          }
          className="flex h-8 shrink-0 items-center gap-1 rounded-full border border-primary/20 bg-primary-subtle px-3 text-xs text-primary hover:border-primary/30"
        >
          <Zap className="h-3 w-3 shrink-0" />
          <span className="max-w-32 truncate">{skill.name}</span>
        </button>
      ))}
    </div>
  );
}

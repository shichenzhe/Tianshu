/**
 * 快速菜单（spec §4 底部工具栏右组）：上组四项预设快捷指令——点击将
 * quick.*.prompt 模板文案整体填入输入框（同 PromptChips 模板胶囊语义）；
 * 下组 quick.skillsGroup 列已启用技能（SkillApi.list filter enabled，
 * 名称字母序同 skill-sub-menu），点击转 pending 引用（label=ref=技能名）。
 * 无已启用技能时整组隐藏。
 */
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Zap } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import SkillApi from "../../skills/api/skill.api";
import { useNewTaskStore } from "../store/new-task-store";

/** 预设快捷指令 i18n 尾 key（label 显示 / prompt 填入） */
const QUICK_COMMANDS = [
  "summarize",
  "translateSel",
  "expand",
  "listify",
] as const;

export default function QuickMenu() {
  const { t } = useTranslation(["newTask"]);
  const setContent = useNewTaskStore((s) => s.setContent);
  const addPending = useNewTaskStore((s) => s.addPending);

  const skillsQuery = useQuery({
    queryKey: ["skillRecords"],
    queryFn: () => SkillApi.list(),
    staleTime: 60_000,
  });
  const enabledSkills = [...(skillsQuery.data ?? [])]
    .filter((skill) => skill.enabled)
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("newTask:quick.title")}
          title={t("newTask:quick.title")}
          className="h-8 w-8 shrink-0 p-0 hover:bg-primary-subtle hover:text-primary"
        >
          <Zap className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-52 border border-border/50 rounded-lg shadow-lg"
      >
        {QUICK_COMMANDS.map((command) => (
          <DropdownMenuItem
            key={command}
            onClick={() => setContent(t(`newTask:quick.${command}.prompt`))}
          >
            {t(`newTask:quick.${command}.label`)}
          </DropdownMenuItem>
        ))}
        {enabledSkills.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>
              {t("newTask:quick.skillsGroup")}
            </DropdownMenuLabel>
            {enabledSkills.map((skill) => (
              <DropdownMenuItem
                key={skill.name}
                title={skill.description ?? skill.name}
                onClick={() =>
                  addPending({
                    label: skill.name,
                    ref: skill.name,
                    kind: "skill",
                  })
                }
              >
                <span className="truncate">{skill.name}</span>
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

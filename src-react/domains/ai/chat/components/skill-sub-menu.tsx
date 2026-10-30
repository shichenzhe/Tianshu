/**
 * ＋菜单「技能」二级浮层（引用选择器语义，2026-10-30 裁定）：搜索过滤
 * + 已启用技能列表（仅 enabled 可见——禁用技能隐藏，启停收口管理页；
 * 此前为全局启停浮层，禁用项可见可点致「已禁用技能仍能被引用」误解）。
 * 勾选 = 已引用进当前输入流（referencedSkills 由宿主按其引用形态给出：
 * 会话/自动化为 ⚡token、落地页为 pending pill），多选切换不关闭浮层；
 * 点击经 onToggleSkill 交宿主接线 + 本地导入 / 管理入口（启停在管理页）
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Check, FolderOpen, Search, Upload, Zap } from "lucide-react";

import { Input } from "@/components/ui/input";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import SkillApi from "../../skills/api/skill.api";

const SKILLS_KEY = ["skillRecords"] as const;
const EXPERTS_SKILLS_ROUTE = "/module/ai/experts?tab=skills&view=installed";

interface SkillSubMenuProps {
  /** 触发本地导入流程（PlusMenu 持有 SkillImportDialog） */
  onImport: () => void;
  /** 当前已引用技能名列表（勾选态依据，宿主按引用形态计算） */
  referencedSkills: string[];
  /** 点击切换引用（宿主接线：⚡token 增删或 pending pill 增删） */
  onToggleSkill: (name: string) => void;
}

export default function SkillSubMenu({
  onImport,
  referencedSkills,
  onToggleSkill,
}: SkillSubMenuProps) {
  const { t } = useTranslation(["chat"]);
  const navigate = useNavigate();
  const [query, setQuery] = useState("");

  const skillsQuery = useQuery({
    queryKey: SKILLS_KEY,
    queryFn: () => SkillApi.list(),
  });
  // 仅已启用技能参与列表（名称字母序保持不变）
  const skills = useMemo(
    () =>
      (skillsQuery.data ?? [])
        .filter((skill) => skill.enabled)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [skillsQuery.data],
  );
  const keyword = query.trim().toLowerCase();
  const filtered = keyword
    ? skills.filter(
        (skill) =>
          skill.name.toLowerCase().includes(keyword) ||
          (skill.description ?? "").toLowerCase().includes(keyword),
      )
    : skills;

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        {/* Zap 同 ChatInput 技能标签 ⚡ 前缀先例（Sparkles 已被模式项占用） */}
        <Zap />
        {t("chat:plus.skill")}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-64 border border-border/50 rounded-lg shadow-lg">
        <div className="p-1.5 pb-1">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("chat:plus.searchSkills")}
              onKeyDownCapture={(e) => e.stopPropagation()}
              className="h-7 border-border/50 pl-7 text-xs"
            />
          </div>
        </div>
        <div className="max-h-64 overflow-y-auto">
          {skillsQuery.isError ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              {t("chat:plus.loadFailed")}
            </p>
          ) : skills.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              {t("chat:plus.skillNoneEnabled")}
            </p>
          ) : filtered.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              {t("chat:plus.skillNoMatch")}
            </p>
          ) : (
            filtered.map((skill) => (
              <DropdownMenuItem
                key={skill.name}
                // 多选：切换引用不关闭浮层，允许连续增删
                onSelect={(e) => e.preventDefault()}
                onClick={() => onToggleSkill(skill.name)}
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-primary-subtle text-[10px] font-semibold uppercase text-primary">
                  {skill.name.slice(0, 1)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">
                    {skill.name}
                  </span>
                  {skill.description && (
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {skill.description}
                    </span>
                  )}
                </span>
                {referencedSkills.includes(skill.name) && (
                  <Check className="ml-auto h-4 w-4 shrink-0 text-primary" />
                )}
              </DropdownMenuItem>
            ))
          )}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onImport}>
          <Upload />
          {t("chat:plus.addLocalSkill")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => navigate(EXPERTS_SKILLS_ROUTE)}>
          <FolderOpen />
          {t("chat:plus.manageSkills")}
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

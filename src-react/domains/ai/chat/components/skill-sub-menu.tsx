/**
 * ＋菜单「技能」二级浮层：搜索过滤 + 已安装技能列表（勾选 = enabled
 * 全局启用，多选切换不关闭浮层，点外部关闭）+ 本地导入 / 管理入口；
 * 空态与搜索无结果态内置，列表按名称字母序
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, FolderOpen, Search, Upload } from "lucide-react";

import { Input } from "@/components/ui/input";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import SkillApi, { type SkillRecord } from "../../skills/api/skill.api";
import { mapIpcError } from "../lib/error-message";

const SKILLS_KEY = ["skillRecords"] as const;
const EXPERTS_SKILLS_ROUTE = "/module/ai/experts?tab=skills&view=installed";

interface SkillSubMenuProps {
  /** 触发本地导入流程（PlusMenu 持有 SkillImportDialog） */
  onImport: () => void;
}

export default function SkillSubMenu({ onImport }: SkillSubMenuProps) {
  const { t } = useTranslation(["chat"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");

  const skillsQuery = useQuery({
    queryKey: SKILLS_KEY,
    queryFn: () => SkillApi.list(),
  });
  const skills = useMemo(
    () =>
      [...(skillsQuery.data ?? [])].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
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

  /** 勾选切换 = 启用/禁用（全局生效），失败 toast 回滚提示由缓存维持 */
  const handleToggle = async (skill: SkillRecord) => {
    try {
      await SkillApi.setEnabled(skill.name, !skill.enabled);
      await queryClient.invalidateQueries({ queryKey: SKILLS_KEY });
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>{t("chat:plus.skill")}</DropdownMenuSubTrigger>
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
              {t("chat:plus.skillEmpty")}
            </p>
          ) : filtered.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              {t("chat:plus.skillNoMatch")}
            </p>
          ) : (
            filtered.map((skill) => (
              <DropdownMenuItem
                key={skill.name}
                // 多选：切换勾选不关闭浮层，允许连续启停
                onSelect={(e) => e.preventDefault()}
                onClick={() => void handleToggle(skill)}
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
                {skill.enabled && (
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

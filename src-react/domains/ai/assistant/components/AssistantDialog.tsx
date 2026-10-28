/**
 * 助手编辑对话框（创建/编辑）：单专家（agent）/ 专家团（team）双类型，
 * team 态编辑 1-13 名团队成员（主理人 systemPrompt + 成员人设）
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";

import IconTooltip from "@/components/common/icon-tooltip";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { parseOptionalInt, parseOptionalNumber } from "../../lib/parse-number";
import AssistantApi, { type AssistantRecord } from "../../api/assistant.api";
import type { TeamMember } from "../../../../../electron/domains/ai/chat/expert-team";
import SkillApi from "../../skills/api/skill.api";
import { EXPERT_CATEGORIES } from "../../experts/data/marketplace";
import { mapIpcError } from "../../chat/lib/error-message";
import {
  diffArrayInput,
  diffOptionalString,
  diffOptionalValue,
} from "../../lib/update-diff";

/** 分类「不限」哨兵：Radix Select 不允许空字符串 value，提交前换回 "" */
const NONE_CATEGORY = "__none__";

const QUICK_PROMPT_ROW_COUNT = 3;

interface AssistantDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing?: AssistantRecord;
}

/** 标签输入解析：逗号分隔 → 去空白去空项的数组 */
function parseTagsInput(raw: string): string[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/** 标签差量：与原值一致 undefined（不改），空数组 null（清空），否则新数组 */
function diffTagsInput(
  raw: string,
  original: string[] | undefined,
): string[] | null | undefined {
  const next = parseTagsInput(raw);
  const joined = next.join(",");
  if (joined === (original ?? []).join(",")) {
    return undefined;
  }
  return joined ? next : null;
}

/** 推荐提示词回填行：既有条目在前，空行补足固定行数 */
function padQuickPromptRows(prompts: string[], rowCount: number): string[] {
  return [...prompts, ...Array(rowCount).fill("")].slice(0, rowCount);
}

/** 推荐提示词解析：逐行 trim、空行剔除 */
function parseQuickPromptRows(rows: string[]): string[] {
  return rows.map((row) => row.trim()).filter(Boolean);
}

/** 成员行数上限：对齐工具侧 TEAM_MEMBERS_MAX=13（electron 常量为运行时值，
 *  前端仅 type-only 跨层引用先例，故自持同值） */
const TEAM_MEMBER_ROW_MAX = 13;

/** 新增成员行占位（四字段空串，满足 TeamMember 全 string 形状） */
function emptyMemberRow(): TeamMember {
  return { id: "", name: "", profession: "", systemPrompt: "" };
}

/** 成员行 → 提交载荷：四字段逐一 trim（id 为调度键，空值由提交校验拦截） */
function parseMemberRows(rows: TeamMember[]): TeamMember[] {
  return rows.map((row) => ({
    id: row.id.trim(),
    name: row.name.trim(),
    profession: row.profession.trim(),
    systemPrompt: row.systemPrompt.trim(),
  }));
}

export default function AssistantDialog({
  open,
  onOpenChange,
  editing,
}: AssistantDialogProps) {
  const { t } = useTranslation(["ai"]);
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [temperature, setTemperature] = useState("");
  const [topP, setTopP] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [description, setDescription] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [profession, setProfession] = useState("");
  const [categoryKey, setCategoryKey] = useState("");
  const [quickPromptRows, setQuickPromptRows] = useState<string[]>([
    "",
    "",
    "",
  ]);
  const [skillNames, setSkillNames] = useState<string[]>([]);
  // 专家类型（默认单专家）与团队成员行（agent 态隐藏不展示，行数据保留
  // 便于误切回退；清列语义在提交时按 expertType 差量处理）
  const [expertType, setExpertType] = useState<"agent" | "team">("agent");
  const [memberRows, setMemberRows] = useState<TeamMember[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // 已安装技能（附带技能胶囊数据源；name 字段对齐 create_expert 的
  // skillNames 过滤口径，不限 enabled——禁用技能仍可被专家附带）
  const skillsQuery = useQuery({
    queryKey: ["skillRecords"],
    queryFn: () => SkillApi.list(),
    staleTime: 60_000,
  });
  const installedSkills = useMemo(
    () =>
      [...(skillsQuery.data ?? [])].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    [skillsQuery.data],
  );

  useEffect(() => {
    if (open) {
      setName(editing?.name ?? "");
      setIcon(editing?.icon ?? "");
      setSystemPrompt(editing?.systemPrompt ?? "");
      setTemperature(
        editing?.temperature === undefined ? "" : String(editing.temperature),
      );
      setTopP(editing?.topP === undefined ? "" : String(editing.topP));
      setMaxTokens(
        editing?.maxTokens === undefined ? "" : String(editing.maxTokens),
      );
      setDescription(editing?.description ?? "");
      setTagsInput((editing?.tags ?? []).join(", "));
      setProfession(editing?.profession ?? "");
      setCategoryKey(editing?.categoryId ?? "");
      setQuickPromptRows(
        padQuickPromptRows(editing?.quickPrompts ?? [], QUICK_PROMPT_ROW_COUNT),
      );
      setSkillNames(editing?.skillNames ?? []);
      // 专家团回填：expertType 归一（记录仅 "team" 或缺省），成员整表回显
      setExpertType(editing?.expertType === "team" ? "team" : "agent");
      setMemberRows(editing?.members ?? []);
    }
  }, [open, editing]);

  const handleSubmit = async () => {
    if (!name.trim() || !systemPrompt.trim() || submitting) {
      return;
    }
    // 团队态至少 1 名成员（T5-M2：空团队无调度目标）；成员 id 为调度键
    // （不做花名转拼音推断），空 id 直接拦截
    const members = parseMemberRows(memberRows);
    if (expertType === "team" && members.length === 0) {
      toast.error(t("ai:assistant.needMember"));
      return;
    }
    if (expertType === "team" && members.some((member) => !member.id)) {
      toast.error(t("ai:assistant.needMemberId"));
      return;
    }
    const quickPrompts = parseQuickPromptRows(quickPromptRows);
    let params;
    try {
      params = {
        name: name.trim(),
        icon: icon.trim() || undefined,
        systemPrompt: systemPrompt.trim(),
        temperature: parseOptionalNumber(temperature),
        topP: parseOptionalNumber(topP),
        maxTokens: parseOptionalInt(maxTokens),
        description: description.trim() || undefined,
        tags: parseTagsInput(tagsInput),
        profession: profession.trim() || undefined,
        categoryId: categoryKey || undefined,
        quickPrompts: quickPrompts.length > 0 ? quickPrompts : undefined,
        skillNames: skillNames.length > 0 ? skillNames : undefined,
        // 新建 agent 态两键不传（默认单专家语义）
        ...(expertType === "team"
          ? { expertType: "team" as const, members }
          : {}),
      };
    } catch {
      toast.error(t("ai:model.invalidNumber"));
      return;
    }
    setSubmitting(true);
    try {
      if (editing) {
        // 编辑态差量提交：可空字段清除时传 null（undefined 会被 Prisma 跳过，旧值残留）
        await AssistantApi.update({
          id: editing.id,
          name: params.name,
          systemPrompt: params.systemPrompt,
          icon: diffOptionalString(icon, editing.icon),
          temperature: diffOptionalValue(
            params.temperature,
            editing.temperature,
          ),
          topP: diffOptionalValue(params.topP, editing.topP),
          maxTokens: diffOptionalValue(params.maxTokens, editing.maxTokens),
          description: diffOptionalString(description, editing.description),
          tags: diffTagsInput(tagsInput, editing.tags),
          profession: diffOptionalString(profession, editing.profession),
          categoryId: diffOptionalString(categoryKey, editing.categoryId),
          quickPrompts: diffArrayInput(quickPrompts, editing.quickPrompts),
          skillNames: diffArrayInput(skillNames, editing.skillNames),
          // agent 显式传（team 转回单专家的通道）：repo 透传写列，读侧
          // toRecord 归一非 "team" 为 agent；members 差量：原无成员
          // undefined（不动列），否则 null（清空成员列）
          expertType: expertType === "team" ? "team" : "agent",
          members:
            expertType === "team"
              ? members
              : (editing.members?.length ?? 0) > 0
                ? null
                : undefined,
        });
      } else {
        await AssistantApi.create(params);
      }
      await queryClient.invalidateQueries({ queryKey: ["assistants"] });
      onOpenChange(false);
    } catch (e) {
      toast.error(mapIpcError(e));
    } finally {
      setSubmitting(false);
    }
  };

  /** 更新推荐提示词某一行（固定行数受控数组） */
  const updateQuickPromptRow = (index: number, value: string) => {
    setQuickPromptRows((rows) =>
      rows.map((row, i) => (i === index ? value : row)),
    );
  };

  /** 附带技能胶囊切换选中 */
  const toggleSkill = (skillName: string) => {
    setSkillNames((names) =>
      names.includes(skillName)
        ? names.filter((n) => n !== skillName)
        : [...names, skillName],
    );
  };

  /** 更新成员行字段（index 定位，浅合并） */
  const updateMemberRow = (index: number, patch: Partial<TeamMember>) => {
    setMemberRows((rows) =>
      rows.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  };

  /** 追加空成员行（≤13 上限：满员不追加） */
  const addMemberRow = () => {
    setMemberRows((rows) =>
      rows.length >= TEAM_MEMBER_ROW_MAX ? rows : [...rows, emptyMemberRow()],
    );
  };

  /** 删除指定成员行 */
  const removeMemberRow = (index: number) => {
    setMemberRows((rows) => rows.filter((_, i) => i !== index));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border border-border/50 rounded-lg shadow-lg sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {editing ? editing.name : t("ai:assistant.add")}
          </DialogTitle>
        </DialogHeader>
        {/* 内容区限高滚动：team 态成员区可能长，头尾（标题/操作钮）常驻 */}
        <div className="max-h-[calc(100vh-12rem)] space-y-4 overflow-y-auto">
          <div className="grid grid-cols-[1fr_100px] gap-3">
            <div className="space-y-1.5">
              <Label>{t("ai:assistant.name")}</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>{t("ai:assistant.icon")}</Label>
              <Input
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
                className="text-center"
              />
            </div>
          </div>
          <div className="flex gap-2">
            {(["agent", "team"] as const).map((type) => (
              <Button
                key={type}
                type="button"
                size="sm"
                variant={expertType === type ? "default" : "outline"}
                className={
                  expertType === type
                    ? undefined
                    : "hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
                }
                onClick={() => setExpertType(type)}
              >
                {t(
                  type === "agent"
                    ? "ai:assistant.typeAgent"
                    : "ai:assistant.typeTeam",
                )}
              </Button>
            ))}
          </div>
          <div className="space-y-1.5">
            <Label>{t("ai:assistant.systemPrompt")}</Label>
            <Textarea
              rows={5}
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
            />
          </div>
          {expertType === "team" && (
            <div className="space-y-2">
              <Label>{t("ai:assistant.membersTitle")}</Label>
              {memberRows.map((row, index) => (
                <div
                  key={index}
                  className="space-y-2 rounded-lg border border-border/50 p-2"
                >
                  <div className="grid grid-cols-2 items-end gap-2">
                    <div className="space-y-1.5">
                      <Label htmlFor={`member-name-${index}`}>
                        {t("ai:assistant.memberName")}
                      </Label>
                      <Input
                        id={`member-name-${index}`}
                        value={row.name}
                        onChange={(e) =>
                          updateMemberRow(index, { name: e.target.value })
                        }
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`member-id-${index}`}>
                        {t("ai:assistant.memberId")}
                      </Label>
                      <Input
                        id={`member-id-${index}`}
                        placeholder={t("ai:assistant.memberIdHint")}
                        value={row.id}
                        onChange={(e) =>
                          updateMemberRow(index, { id: e.target.value })
                        }
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`member-profession-${index}`}>
                        {t("ai:assistant.memberProfession")}
                      </Label>
                      <Input
                        id={`member-profession-${index}`}
                        value={row.profession}
                        onChange={(e) =>
                          updateMemberRow(index, { profession: e.target.value })
                        }
                      />
                    </div>
                    <IconTooltip label={t("common:delete")}>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={t("common:delete")}
                        onClick={() => removeMemberRow(index)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </IconTooltip>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`member-prompt-${index}`}>
                      {t("ai:assistant.memberPrompt")}
                    </Label>
                    <Textarea
                      id={`member-prompt-${index}`}
                      rows={3}
                      value={row.systemPrompt}
                      onChange={(e) =>
                        updateMemberRow(index, { systemPrompt: e.target.value })
                      }
                    />
                  </div>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={memberRows.length >= TEAM_MEMBER_ROW_MAX}
                className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
                onClick={addMemberRow}
              >
                {t("ai:assistant.addMember")}
              </Button>
            </div>
          )}
          <div className="space-y-1.5">
            <Label>{t("ai:assistant.description")}</Label>
            <Textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t("ai:assistant.tags")}</Label>
            <Input
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t("ai:assistant.profession")}</Label>
            <Input
              value={profession}
              onChange={(e) => setProfession(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t("ai:assistant.category")}</Label>
            <Select
              value={categoryKey || NONE_CATEGORY}
              onValueChange={(value) =>
                setCategoryKey(value === NONE_CATEGORY ? "" : value)
              }
            >
              <SelectTrigger
                aria-label={t("ai:assistant.category")}
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border border-border/50 rounded-lg shadow-lg">
                <SelectItem value={NONE_CATEGORY}>
                  {t("ai:assistant.noCategory")}
                </SelectItem>
                {EXPERT_CATEGORIES.map((category) => (
                  <SelectItem key={category.key} value={category.key}>
                    {t(`chat:experts.categories.${category.labelKey}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t("ai:assistant.quickPrompts")}</Label>
            {quickPromptRows.map((row, index) => (
              <Input
                key={index}
                value={row}
                placeholder={
                  index === 0 ? t("ai:assistant.quickPromptHint") : undefined
                }
                onChange={(e) => updateQuickPromptRow(index, e.target.value)}
              />
            ))}
          </div>
          <div className="space-y-1.5">
            <Label>{t("ai:assistant.attachedSkills")}</Label>
            {installedSkills.length > 0 ? (
              <div className="flex flex-wrap gap-2 pt-0.5">
                {installedSkills.map((skill) => (
                  <button
                    key={skill.name}
                    type="button"
                    onClick={() => toggleSkill(skill.name)}
                    className={cn(
                      "rounded-full border px-3 py-1 text-xs transition-colors",
                      skillNames.includes(skill.name)
                        ? "bg-primary-subtle text-primary border-primary/30"
                        : "border-border/50 text-muted-foreground hover:bg-primary-subtle hover:text-primary hover:border-primary/30",
                    )}
                  >
                    {skill.name}
                  </button>
                ))}
              </div>
            ) : (
              !skillsQuery.isLoading && (
                <p className="text-xs text-muted-foreground">
                  {t("ai:assistant.noSkills")}
                </p>
              )
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {t("ai:model.optionalHint")}
          </p>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label>{t("ai:model.temperature")}</Label>
              <Input
                type="number"
                step="0.1"
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t("ai:model.topP")}</Label>
              <Input
                type="number"
                step="0.1"
                value={topP}
                onChange={(e) => setTopP(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t("ai:model.maxTokens")}</Label>
              <Input
                type="number"
                step="1"
                min="1"
                value={maxTokens}
                onChange={(e) => setMaxTokens(e.target.value)}
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common:cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? t("common:saving") : t("common:confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

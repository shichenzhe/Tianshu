/**
 * 新建项目弹窗（spec §6.2）：
 * 项目名称（必填 ≤15 字，实时长度校验）→ 指令配置（模版下拉 + 长文本域，
 * 覆盖确认状态机：文本域有内容时切模版 → AlertDialog，确认覆盖 / 取消回弹）
 * → 三类能力挂载（连接器/专家/技能，PickerDialog 多选 + Tag 展示可移除）
 * → 提交 ProjectApi.create；重名内联提示，其他失败 toast，弹窗均不关闭。
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { AssistantApi } from "@/domains/ai/api/assistant.api";
import { McpServerApi } from "@/domains/ai/api/mcp.api";
import SkillApi from "@/domains/ai/skills/api/skill.api";
import { useUserStore } from "@/domains/user/store/user.store";
import { getTemplate, PROJECT_TEMPLATES } from "../model/project-templates";
import ProjectApi from "../api/project.api";
import PickerDialog, { type PickerItem } from "./PickerDialog";
import RemovableTag from "./RemovableTag";
import type {
  ProjectBindingInput,
  ProjectBindingType,
  ProjectRecord,
} from "../../../../electron/domains/project/project.entity";

interface CreateProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 从模版卡片进入时预选的模版 key */
  presetTemplateKey?: string;
  /** 创建成功回调（父级负责跳转 /module/project/:id） */
  onCreated: (project: ProjectRecord) => void;
}

/**
 * 重名错误码：与 electron/domains/project/project.entity 的同名常量保持
 * 同值（渲染进程不 import 主进程运行时代码，镜像声明，参照 blocks.ts 先例）
 */
const PROJECT_NAME_EXISTS = "PROJECT_NAME_EXISTS";

/** Radix Select 禁用空串 value，以哨兵值表示"不使用模版" */
const TEMPLATE_NONE = "__none__";

const NAME_MAX_LENGTH = 15;

const CAPABILITY_KINDS: Array<{
  kind: ProjectBindingType;
  labelKey: string;
}> = [
  { kind: "mcpServer", labelKey: "project:create.connectors" },
  { kind: "assistant", labelKey: "project:create.experts" },
  { kind: "skill", labelKey: "project:create.skills" },
];

type SelectedByKind = Record<ProjectBindingType, number[]>;

export default function CreateProjectDialog({
  open,
  onOpenChange,
  presetTemplateKey,
  onCreated,
}: CreateProjectDialogProps) {
  const { t } = useTranslation(["project", "common"]);
  const queryClient = useQueryClient();
  const user = useUserStore((state) => state.user);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [selectedTemplateKey, setSelectedTemplateKey] = useState<string | null>(
    null,
  );
  const [dirty, setDirty] = useState(false);
  const [pendingTemplateKey, setPendingTemplateKey] = useState<string | null>(
    null,
  );
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pickerKind, setPickerKind] = useState<ProjectBindingType | null>(null);
  const [selectedByKind, setSelectedByKind] = useState<SelectedByKind>({
    assistant: [],
    skill: [],
    mcpServer: [],
  });
  const [creating, setCreating] = useState(false);

  // 打开（或换预选模版）时重置表单
  const resetForm = useCallback((templateKey: string | null) => {
    setSelectedTemplateKey(templateKey);
    setPrompt(templateKey ? (getTemplate(templateKey)?.prompt ?? "") : "");
    setDirty(false);
    setPendingTemplateKey(null);
    setConfirmOpen(false);
    setName("");
    setNameError(null);
    setPickerKind(null);
    setSelectedByKind({ assistant: [], skill: [], mcpServer: [] });
    setCreating(false);
  }, []);

  useEffect(() => {
    if (open) resetForm(presetTemplateKey ?? null);
  }, [open, presetTemplateKey, resetForm]);

  const { data: assistants = [] } = useQuery({
    queryKey: ["assistants"],
    queryFn: () => AssistantApi.list(),
  });
  const { data: skills = [] } = useQuery({
    queryKey: ["skillRecords"],
    queryFn: () => SkillApi.list(),
  });
  const { data: mcpServers = [] } = useQuery({
    queryKey: ["mcpServers"],
    queryFn: () => McpServerApi.list(),
  });

  const pickerItemsByKind: Record<ProjectBindingType, PickerItem[]> = {
    assistant: assistants.map((item) => ({ id: item.id, name: item.name })),
    skill: skills.map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description ?? undefined,
    })),
    mcpServer: mcpServers.map((item) => ({
      id: item.id,
      name: item.name,
      description: item.url ?? item.command,
    })),
  };

  // 模版覆盖确认状态机（PRD 4.1）：dirty 标记手动编辑、模版填充重置；
  // 文本域有内容（手动编辑或先前模版填充）时切换需二次确认
  const applyTemplate = (templateKey: string | null) => {
    setSelectedTemplateKey(templateKey);
    setPrompt(templateKey ? (getTemplate(templateKey)?.prompt ?? "") : "");
    setDirty(false);
  };

  const handleTemplateSelect = (value: string) => {
    const nextKey = value === TEMPLATE_NONE ? null : value;
    if (dirty || prompt.trim().length > 0) {
      setPendingTemplateKey(nextKey);
      setConfirmOpen(true);
      return;
    }
    applyTemplate(nextKey);
  };

  const handleOverwriteConfirm = () => {
    applyTemplate(pendingTemplateKey);
    setPendingTemplateKey(null);
    setConfirmOpen(false);
  };

  const handleOverwriteCancel = () => {
    setPendingTemplateKey(null);
    setConfirmOpen(false);
  };

  const handleNameChange = (value: string) => {
    setName(value);
    setNameError(
      value.trim().length > NAME_MAX_LENGTH
        ? t("project:create.nameTooLong")
        : null,
    );
  };

  const handleCreateError = (error: unknown) => {
    if (error instanceof Error && error.message.includes(PROJECT_NAME_EXISTS)) {
      setNameError(t("project:create.nameExists"));
      return;
    }
    toast.error(t("project:toast.createFailed"));
  };

  const buildBindings = (): ProjectBindingInput[] =>
    CAPABILITY_KINDS.flatMap(({ kind }) =>
      selectedByKind[kind].map((itemId) => ({ itemType: kind, itemId })),
    );

  const handleSubmit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError(t("project:create.nameRequired"));
      return;
    }
    if (trimmed.length > NAME_MAX_LENGTH || creating) return;
    setCreating(true);
    try {
      const record = await ProjectApi.create({
        ownerId: user.id,
        name: trimmed,
        systemPrompt: prompt.trim() || undefined,
        templateKey: selectedTemplateKey ?? undefined,
        welcomeMessage: selectedTemplateKey
          ? getTemplate(selectedTemplateKey)?.welcome
          : undefined,
        bindings: buildBindings(),
      });
      toast.success(t("project:toast.created"));
      // 前缀失效：侧栏列表与 Hub 卡片共用 ["projects", ownerId] 缓存，一并刷新
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      onCreated(record);
      onOpenChange(false);
    } catch (error) {
      handleCreateError(error);
    } finally {
      setCreating(false);
    }
  };

  const handlePickerConfirm = (ids: number[]) => {
    if (pickerKind) {
      setSelectedByKind((prev) => ({ ...prev, [pickerKind]: ids }));
    }
  };

  const handleRemoveBinding = (kind: ProjectBindingType, itemId: number) => {
    setSelectedByKind((prev) => ({
      ...prev,
      [kind]: prev[kind].filter((id) => id !== itemId),
    }));
  };

  const pickerLabel = (kind: ProjectBindingType | null) =>
    t(CAPABILITY_KINDS.find((entry) => entry.kind === kind)?.labelKey ?? "");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="max-h-[85vh] overflow-y-auto rounded-lg border-border/50 shadow-lg sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>{t("project:create.title")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="create-project-name">
              {t("project:create.nameLabel")}
            </Label>
            <Input
              id="create-project-name"
              value={name}
              onChange={(event) => handleNameChange(event.target.value)}
              placeholder={t("project:create.namePlaceholder")}
              aria-invalid={nameError !== null}
            />
            {nameError && (
              <p className="text-xs text-destructive">{nameError}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>{t("project:create.promptLabel")}</Label>
            <Select
              value={selectedTemplateKey ?? TEMPLATE_NONE}
              onValueChange={handleTemplateSelect}
            >
              <SelectTrigger aria-label={t("project:create.templateLabel")}>
                <SelectValue placeholder={t("project:create.templateBlank")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={TEMPLATE_NONE}>
                  {t("project:create.templateBlank")}
                </SelectItem>
                {PROJECT_TEMPLATES.map((template) => (
                  <SelectItem key={template.key} value={template.key}>
                    {template.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Textarea
              rows={5}
              value={prompt}
              onChange={(event) => {
                setPrompt(event.target.value);
                setDirty(true);
              }}
              placeholder={t("project:create.promptPlaceholder")}
            />
          </div>

          <div className="space-y-2">
            <Label>{t("project:create.capabilities")}</Label>
            {CAPABILITY_KINDS.map(({ kind, labelKey }) => (
              <CapabilitySection
                key={kind}
                label={t(labelKey)}
                items={pickerItemsByKind[kind]}
                selectedIds={selectedByKind[kind]}
                onAdd={() => setPickerKind(kind)}
                onRemove={(itemId) => handleRemoveBinding(kind, itemId)}
              />
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
          >
            {t("common:cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={creating}>
            {creating ? t("common:saving") : t("common:confirm")}
          </Button>
        </DialogFooter>

        {/* 模版覆盖确认（状态机确认分支 / 取消回弹分支） */}
        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogContent
            aria-describedby={undefined}
            className="rounded-lg border-border/50 shadow-lg"
          >
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("project:create.overwriteTitle")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("project:create.overwriteDesc")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={handleOverwriteCancel}>
                {t("common:cancel")}
              </AlertDialogCancel>
              <AlertDialogAction onClick={handleOverwriteConfirm}>
                {t("project:create.overwriteConfirm")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* 能力挂载选择器（同一时刻至多一个） */}
        {pickerKind && (
          <PickerDialog
            open
            onOpenChange={(next) => {
              if (!next) setPickerKind(null);
            }}
            title={pickerLabel(pickerKind)}
            items={pickerItemsByKind[pickerKind]}
            selectedIds={selectedByKind[pickerKind]}
            onConfirm={handlePickerConfirm}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

interface CapabilitySectionProps {
  label: string;
  items: PickerItem[];
  selectedIds: number[];
  onAdd: () => void;
  onRemove: (itemId: number) => void;
}

/** 单类能力挂载区：标题 + 添加按钮 + 已选 Tag 列表 */
function CapabilitySection({
  label,
  items,
  selectedIds,
  onAdd,
  onRemove,
}: CapabilitySectionProps) {
  const { t } = useTranslation(["project", "common"]);
  return (
    <section
      aria-label={label}
      className="space-y-2 rounded-lg border border-border/50 p-3"
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onAdd}
          className="h-7 gap-1 px-2 hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
        >
          <Plus className="h-3.5 w-3.5" />
          {t("project:create.add")}
        </Button>
      </div>
      {selectedIds.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedIds.map((itemId) => (
            <RemovableTag
              key={itemId}
              name={
                items.find((item) => item.id === itemId)?.name ?? `#${itemId}`
              }
              onRemove={() => onRemove(itemId)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

// 计划事项弹窗（A7 批，hub 我的任务/项目计划页共用）：新建/编辑同壳。
// 字段全集：标题/描述/状态/优先级/处理人/标签/起止日期/自定义字段值
// （fields 定义驱动：text→文本、number→数字键盘、date→日期输入）；
// projectId 为 null（本地任务）时隐藏项目字段（处理人/日期/自定义字段）
// 与附件区；附件区仅编辑态渲染：列表（删关联不删文件，Alert 确认）+
// 「从资产挂接」（资产根下扁平文件挑选）。日期 dateKeyToIso 入库、
// isoToDateKey 回填，YYYY-MM-DD 格式校验不过即红字阻断提交。
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Pressable, Text, View } from "react-native";
import { Paperclip, Plus, X } from "lucide-react-native";
import {
  PLAN_PRIORITIES,
  PLAN_STATUSES,
  type AssetEntryDto,
  type PlanFieldDefDto,
  type PlanItemAttachmentRecordDto,
  type PlanItemCreatePayload,
  type PlanItemRecordDto,
  type PlanItemUpdatePayload,
  type PlanPriority,
  type PlanStatus,
  type ProjectMemberItemDto,
} from "@tianshu/protocol";
import { dateKeyToIso, isoToDateKey } from "@/logic/plan-view";

import { DialogShell } from "@/components/DialogShell";
import { FormField } from "@/components/FormField";
import { FormFooter } from "@/components/FormFooter";
import { ACTION_DANGER } from "@/components/AppActionSheet";
import { useProjectStore } from "@/store/project.store";
import { useThemeColors } from "@/store/theme";

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** chips 单选行（状态/优先级/处理人共用：横排圆角胶囊） */
function ChipRow<T extends string>({
  options,
  value,
  onSelect,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onSelect: (value: T) => void;
}) {
  const colors = useThemeColors();
  return (
    <View className="flex-row flex-wrap gap-2">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onSelect(option.value)}
            className="rounded-full border px-3 py-1.5"
            style={{
              borderColor: active ? colors.primary : "transparent",
              backgroundColor: active ? colors.subtle : colors.subtle,
              opacity: active ? 1 : 0.6,
            }}
          >
            <Text
              className="text-xs"
              style={{ color: active ? colors.primary : undefined }}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** 附件区（编辑态 + 项目任务）：已挂列表 + 资产根挑文件挂接 */
function AttachmentSection({
  item,
  projectId,
}: {
  item: PlanItemRecordDto;
  projectId: number;
}) {
  const { t } = useTranslation("project");
  const colors = useThemeColors();
  const [attachments, setAttachments] = useState<
    PlanItemAttachmentRecordDto[] | null
  >(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [candidates, setCandidates] = useState<AssetEntryDto[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void useProjectStore
      .getState()
      .listAttachments(item.id)
      .then((rows) => {
        if (!cancelled) setAttachments(rows);
      });
    return () => {
      cancelled = true;
    };
  }, [item.id]);

  function openPicker() {
    setPickerOpen(true);
    setCandidates(null);
    void useProjectStore
      .getState()
      .peekAssets(projectId)
      .then((rows) =>
        setCandidates(rows.filter((row) => row.type === "file")),
      );
  }

  function confirmRemove(row: PlanItemAttachmentRecordDto) {
    Alert.alert(t("attachments"), t("removeAttachmentConfirm", { name: row.fileName }), [
      { text: t("common:cancel"), style: "cancel" },
      {
        text: t("common:confirm"),
        style: "destructive",
        onPress: () => {
          void useProjectStore
            .getState()
            .removeAttachment(row.id)
            .then((ok) => {
              if (ok) {
                setAttachments(
                  (rows) => rows?.filter((r) => r.id !== row.id) ?? null,
                );
              }
            });
        },
      },
    ]);
  }

  function attach(row: AssetEntryDto) {
    setPickerOpen(false);
    void useProjectStore
      .getState()
      .createAttachment(item.id, row.name, row.name)
      .then((ok) => {
        if (!ok) return;
        setAttachments(null);
        void useProjectStore
          .getState()
          .listAttachments(item.id)
          .then(setAttachments);
      });
  }

  return (
    <View className="gap-2">
      <Text className="text-xs text-label2 dark:text-[#EBEBF599]">
        {t("attachments")}
      </Text>
      {attachments === null ? null : attachments.length === 0 ? (
        <Text className="text-xs text-label3 dark:text-[#EBEBF54D]">
          {t("emptyAssets")}
        </Text>
      ) : (
        attachments.map((row) => (
          <View key={row.id} className="flex-row items-center gap-2">
            <Paperclip size={14} color={colors.primary} />
            <Text
              numberOfLines={1}
              className="min-w-0 flex-1 text-sm text-black dark:text-white"
            >
              {row.fileName}
            </Text>
            <Pressable onPress={() => confirmRemove(row)} hitSlop={8}>
              <X size={16} color={ACTION_DANGER} />
            </Pressable>
          </View>
        ))
      )}
      {pickerOpen ? (
        <View className="gap-1 rounded-lg border border-sep p-2 dark:border-[#545458A6]">
          <Text className="text-xs text-label3 dark:text-[#EBEBF54D]">
            {t("attachmentFromAssets")}
          </Text>
          {candidates === null ? (
            <Text className="text-xs text-label3 dark:text-[#EBEBF54D]">…</Text>
          ) : candidates.length === 0 ? (
            <Text className="text-xs text-label3 dark:text-[#EBEBF54D]">
              {t("emptyAssets")}
            </Text>
          ) : (
            candidates.map((row) => (
              <Pressable
                key={row.name}
                onPress={() => attach(row)}
                className="rounded-md px-2 py-1.5"
                style={({ pressed }) => ({
                  backgroundColor: pressed ? colors.subtle : "transparent",
                })}
              >
                <Text className="text-sm text-black dark:text-white">
                  {row.name}
                </Text>
              </Pressable>
            ))
          )}
        </View>
      ) : (
        <Pressable
          onPress={openPicker}
          className="flex-row items-center gap-1 self-start"
          hitSlop={8}
        >
          <Plus size={14} color={colors.primary} />
          <Text className="text-xs" style={{ color: colors.primary }}>
            {t("addAttachment")}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

export function PlanItemDialog({
  projectId,
  item,
  defaultStatus,
  members,
  fields,
  busy,
  onClose,
  onSubmit,
}: {
  /** 所属项目 id；null = 本地任务（隐藏项目字段与附件区） */
  projectId: number | null;
  /** 编辑目标；缺省 = 新建 */
  item?: PlanItemRecordDto;
  /** 新建态初始状态（组尾「+」快速新建预置；编辑态忽略） */
  defaultStatus?: PlanStatus;
  members: ProjectMemberItemDto[];
  fields: PlanFieldDefDto[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (
    payload: PlanItemCreatePayload | PlanItemUpdatePayload,
  ) => void;
}) {
  const { t } = useTranslation(["project", "common"]);
  const isEdit = item !== undefined;
  const isProjectTask = projectId !== null;
  const [title, setTitle] = useState(item?.title ?? "");
  const [description, setDescription] = useState(item?.description ?? "");
  const [status, setStatus] = useState<PlanStatus>(
    item?.status ?? defaultStatus ?? "not_started",
  );
  const [priority, setPriority] = useState<PlanPriority>(
    item?.priority ?? "P2",
  );
  const [assigneeId, setAssigneeId] = useState<number | null>(
    item?.assigneeId ?? null,
  );
  const [tagsInput, setTagsInput] = useState((item?.tags ?? []).join(", "));
  const [startKey, setStartKey] = useState(isoToDateKey(item?.startDate ?? ""));
  const [dueKey, setDueKey] = useState(isoToDateKey(item?.dueDate ?? ""));
  const [customInput, setCustomInput] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    fields.forEach((field) => {
      const value = item?.customFields?.[field.name];
      initial[field.name] = value === undefined || value === null ? "" : String(value);
    });
    return initial;
  });
  const [dateError, setDateError] = useState(false);

  const statusOptions = PLAN_STATUSES.map((value) => ({
    value,
    label: t(`project:status.${value}`),
  }));
  const priorityOptions = PLAN_PRIORITIES.map((value) => ({
    value,
    label: t(`project:priority.${value}`),
  }));
  const assigneeOptions = [
    { value: "unassigned", label: t("project:unassigned") },
    ...members.map((member) => ({
      value: String(member.userId),
      label: member.nickname,
    })),
  ];

  /** 日期校验：空串放行（=清空）；非空须 YYYY-MM-DD */
  function dateValid(key: string): boolean {
    return key === "" || DATE_KEY_PATTERN.test(key);
  }

  function handleConfirm() {
    const trimmed = title.trim();
    if (!trimmed) return;
    if (!dateValid(startKey) || !dateValid(dueKey)) {
      setDateError(true);
      return;
    }
    const tags = tagsInput
      .split(/[,，]/)
      .map((tag) => tag.trim())
      .filter(Boolean);
    const customFields: Record<string, string | number> = {};
    fields.forEach((field) => {
      const raw = (customInput[field.name] ?? "").trim();
      if (raw === "") return;
      customFields[field.name] =
        field.type === "number" && !Number.isNaN(Number(raw))
          ? Number(raw)
          : raw;
    });
    const common = {
      title: trimmed,
      description: description.trim() === "" ? null : description.trim(),
      status,
      priority,
      tags,
      ...(isProjectTask
        ? {
            assigneeId,
            startDate: startKey === "" ? null : dateKeyToIso(startKey),
            dueDate: dueKey === "" ? null : dateKeyToIso(dueKey),
            customFields,
          }
        : {}),
    };
    onSubmit(
      isEdit
        ? { id: item.id, ...common }
        : { ...common, projectId: projectId ?? undefined },
    );
  }

  return (
    <DialogShell
      title={t(isEdit ? "project:itemDialog.edit" : "project:itemDialog.create")}
      busy={busy}
      onClose={onClose}
      footer={
        <FormFooter
          busy={busy}
          confirmDisabled={!title.trim()}
          onConfirm={handleConfirm}
          onCancel={onClose}
        />
      }
    >
      <FormField
        label={t("project:itemDialog.title")}
        value={title}
        onChangeText={setTitle}
      />
      <FormField
        label={t("project:itemDialog.description")}
        value={description}
        onChangeText={setDescription}
        multiline
      />
      <View className="gap-1.5">
        <Text className="text-xs text-label2 dark:text-[#EBEBF599]">
          {t("project:itemDialog.status")}
        </Text>
        <ChipRow
          options={statusOptions}
          value={status}
          onSelect={setStatus}
        />
      </View>
      <View className="gap-1.5">
        <Text className="text-xs text-label2 dark:text-[#EBEBF599]">
          {t("project:itemDialog.priority")}
        </Text>
        <ChipRow
          options={priorityOptions}
          value={priority}
          onSelect={setPriority}
        />
      </View>
      {isProjectTask && (
        <View className="gap-1.5">
          <Text className="text-xs text-label2 dark:text-[#EBEBF599]">
            {t("project:assignee")}
          </Text>
          <ChipRow
            options={assigneeOptions}
            value={assigneeId === null ? "unassigned" : String(assigneeId)}
            onSelect={(value) =>
              setAssigneeId(value === "unassigned" ? null : Number(value))
            }
          />
        </View>
      )}
      <FormField
        label={t("project:tags")}
        value={tagsInput}
        onChangeText={setTagsInput}
      />
      {isProjectTask && (
        <>
          <FormField
            label={t("project:startDate")}
            value={startKey}
            onChangeText={(text) => {
              setStartKey(text);
              setDateError(false);
            }}
            placeholder="YYYY-MM-DD"
          />
          <FormField
            label={t("project:dueDate")}
            value={dueKey}
            onChangeText={(text) => {
              setDueKey(text);
              setDateError(false);
            }}
            placeholder="YYYY-MM-DD"
          />
          {dateError && (
            <Text className="text-xs text-red-500">
              {t("project:itemDialog.dateInvalid")}
            </Text>
          )}
          {fields.length > 0 && (
            <View className="gap-2">
              <Text className="text-xs text-label2 dark:text-[#EBEBF599]">
                {t("project:itemDialog.customFields")}
              </Text>
              {fields.map((field) => (
                <FormField
                  key={field.name}
                  label={field.name}
                  value={customInput[field.name] ?? ""}
                  onChangeText={(text) =>
                    setCustomInput((prev) => ({ ...prev, [field.name]: text }))
                  }
                  keyboardType={
                    field.type === "number" ? "numeric" : "default"
                  }
                  placeholder={field.type === "date" ? "YYYY-MM-DD" : undefined}
                />
              ))}
            </View>
          )}
        </>
      )}
      {isEdit && isProjectTask && item && (
        <AttachmentSection item={item} projectId={projectId} />
      )}
    </DialogShell>
  );
}

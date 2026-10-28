import { useEffect, useMemo, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Check, MessageSquarePlus, Plus, Trash2 } from "lucide-react-native";

import { DialogShell } from "@/components/DialogShell";
import { FormField, PLACEHOLDER } from "@/components/FormField";
import { FormFooter } from "@/components/FormFooter";
import { GroupSection } from "@/components/GroupSection";
import { ListItem } from "@/components/ListItem";
import { PageHeader } from "@/components/PageHeader";
import {
  buildModelSave,
  buildProviderSave,
  importRemoteModels,
  prepareRemoteModels,
  type RemoteModelChoice,
} from "@/logic/provider-config";
import { toast } from "@/lib/toast-bus";
import {
  useConnectionsStore,
  useConnectionCapabilities,
} from "@/store/connections.store";
import {
  useProvidersStore,
  type ModelRow,
  type ProviderRow,
} from "@/store/providers.store";
import { useThemeColors } from "@/store/theme";

const DANGER = "#FF3B30";
const MODEL_TYPES = ["llm", "embedding", "tts", "reranker", "asr"];
const PROVIDER_PRESETS = [
  {
    labelKey: "presetOpenAI",
    type: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
  },
  {
    labelKey: "presetAnthropic",
    type: "anthropic",
    baseUrl: "https://api.anthropic.com",
  },
  {
    labelKey: "presetGemini",
    type: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  },
  {
    labelKey: "presetOllama",
    type: "ollama",
    baseUrl: "http://localhost:11434",
  },
  {
    labelKey: "presetComfyUI",
    type: "comfyui",
    baseUrl: "http://127.0.0.1:8188",
  },
];

function notifySaveFailure(t: TFunction, message?: string | null) {
  const detail =
    message === undefined
      ? (useProvidersStore.getState().error ?? "")
      : (message ?? "");
  toast.error(t("providers:saveFailed", { message: detail }));
}

function FormSwitch({
  label,
  value,
  disabled,
  onValueChange,
}: {
  label: string;
  value: boolean;
  disabled: boolean;
  onValueChange: (value: boolean) => void;
}) {
  const colors = useThemeColors();
  return (
    <View className="flex-row items-center gap-3 py-1">
      <Text className="flex-1 text-sm text-black dark:text-white">{label}</Text>
      <Switch
        value={value}
        disabled={disabled}
        onValueChange={onValueChange}
        trackColor={{ false: colors.subtle, true: colors.primary }}
        ios_backgroundColor={colors.subtle}
      />
    </View>
  );
}

function PresetPicker({
  disabled,
  onSelect,
}: {
  disabled: boolean;
  onSelect: (preset: (typeof PROVIDER_PRESETS)[number]) => void;
}) {
  const { t } = useTranslation("providers");
  const colors = useThemeColors();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ flexGrow: 0, flexShrink: 0 }}
      contentContainerStyle={{ alignItems: "flex-start", gap: 8 }}
    >
      {PROVIDER_PRESETS.map((preset) => (
        <Pressable
          key={preset.type}
          disabled={disabled}
          onPress={() => onSelect(preset)}
          className="rounded-full border border-sep px-3 py-2 dark:border-[#545458A6]"
          style={({ pressed }) => ({
            backgroundColor: pressed ? colors.subtle : undefined,
            opacity: disabled ? 0.45 : 1,
          })}
        >
          <Text className="text-xs text-black dark:text-white">
            {t(preset.labelKey)}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

function ProviderDialog({
  open,
  editing,
  onClose,
}: {
  open: boolean;
  editing: ProviderRow | null;
  onClose: () => void;
}) {
  const { t } = useTranslation(["providers", "common"]);
  const saving = useProvidersStore((state) => state.saving);
  const saveProvider = useProvidersStore((state) => state.saveProvider);
  const [name, setName] = useState("");
  const [type, setType] = useState("openai-compatible");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [extraHeaders, setExtraHeaders] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [clearApiKey, setClearApiKey] = useState(false);
  const [clearExtraHeaders, setClearExtraHeaders] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? "");
    setType(editing?.type ?? "openai-compatible");
    setBaseUrl(editing?.baseUrl ?? "");
    setApiKey("");
    setExtraHeaders(editing?.extraHeaders ?? "");
    setEnabled(editing?.enabled ?? true);
    setClearApiKey(false);
    setClearExtraHeaders(false);
    setError(null);
  }, [open, editing]);

  if (!open) return null;

  async function handleSubmit() {
    if (saving) return;
    const result = buildProviderSave(
      {
        name,
        type,
        baseUrl,
        apiKey,
        extraHeaders,
        enabled,
        clearApiKey,
        clearExtraHeaders,
      },
      editing?.id,
    );
    if (!result.ok) {
      if (result.error !== "required") setError(result.error);
      return;
    }
    if (await saveProvider(result.item)) onClose();
    else notifySaveFailure(t);
  }

  return (
    <DialogShell
      title={t(editing ? "providers:editProvider" : "providers:addProvider")}
      busy={saving}
      onClose={onClose}
      footer={
        <FormFooter
          busy={saving}
          confirmDisabled={!name.trim() || !baseUrl.trim()}
          onConfirm={() => void handleSubmit()}
          onCancel={onClose}
        />
      }
    >
      {!editing && (
        <PresetPicker
          disabled={saving}
          onSelect={(preset) => {
            setType(preset.type);
            setBaseUrl(preset.baseUrl);
          }}
        />
      )}
      <FormField
        label={t("providers:name")}
        value={name}
        onChangeText={setName}
      />
      <FormField
        label={t("providers:type")}
        value={type}
        onChangeText={setType}
      />
      <FormField
        label={t("providers:baseUrl")}
        value={baseUrl}
        onChangeText={setBaseUrl}
      />
      <View className="gap-2">
        <FormField
          label={t("providers:apiKey")}
          value={apiKey}
          onChangeText={(value) => {
            setApiKey(value);
            setClearApiKey(false);
          }}
          placeholder={editing ? t("providers:apiKeyKeep") : undefined}
          secure
        />
        {editing?.apiKey != null && (
          <Pressable
            disabled={saving || clearApiKey}
            onPress={() => {
              setApiKey("");
              setClearApiKey(true);
            }}
            className="self-start"
            hitSlop={8}
          >
            <Text className="text-xs" style={{ color: DANGER }}>
              {t("providers:clear")}
            </Text>
          </Pressable>
        )}
        {clearApiKey && (
          <Text className="text-xs text-red-500">
            {t("providers:apiKeyClearPending")}
          </Text>
        )}
      </View>
      <View className="gap-2">
        <FormField
          label={t("providers:extraHeaders")}
          value={extraHeaders}
          onChangeText={(value) => {
            setExtraHeaders(value);
            setClearExtraHeaders(false);
            setError(null);
          }}
          placeholder={editing ? t("providers:extraHeadersKeep") : undefined}
          multiline
        />
        {editing?.extraHeaders != null && (
          <Pressable
            disabled={saving || clearExtraHeaders}
            onPress={() => {
              setExtraHeaders("");
              setClearExtraHeaders(true);
              setError(null);
            }}
            className="self-start"
            hitSlop={8}
          >
            <Text className="text-xs" style={{ color: DANGER }}>
              {t("providers:clear")}
            </Text>
          </Pressable>
        )}
        {clearExtraHeaders && (
          <Text className="text-xs text-red-500">
            {t("providers:extraHeadersClearPending")}
          </Text>
        )}
      </View>
      {error && <Text className="text-xs text-red-500">{t(error)}</Text>}
      <FormSwitch
        label={t("providers:enabled")}
        value={enabled}
        disabled={saving}
        onValueChange={setEnabled}
      />
    </DialogShell>
  );
}

function ModelTypeSegments({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled: boolean;
  onChange: (type: string) => void;
}) {
  const colors = useThemeColors();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ flexGrow: 0, flexShrink: 0 }}
      contentContainerStyle={{ alignItems: "flex-start" }}
    >
      <View className="flex-row rounded-lg border border-sep p-0.5 dark:border-[#545458A6]">
        {MODEL_TYPES.map((type) => {
          const active = type === value;
          return (
            <Pressable
              key={type}
              disabled={disabled}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              onPress={() => onChange(type)}
              className="items-center rounded-md px-3 py-2"
              style={{
                backgroundColor: active ? colors.primary : "transparent",
              }}
            >
              <Text
                className={`text-xs ${active ? "font-medium text-white" : "text-label2 dark:text-[#EBEBF599]"}`}
              >
                {type}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </ScrollView>
  );
}

function ModelDialog({
  open,
  providerId,
  editing,
  externalBusy,
  onClose,
  onDelete,
}: {
  open: boolean;
  providerId: number;
  editing: ModelRow | null;
  externalBusy: boolean;
  onClose: () => void;
  onDelete: (model: ModelRow) => void;
}) {
  const { t } = useTranslation(["providers", "common"]);
  const saving = useProvidersStore((state) => state.saving);
  const saveModel = useProvidersStore((state) => state.saveModel);
  const [modelId, setModelId] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState("llm");
  const [temperature, setTemperature] = useState("");
  const [topP, setTopP] = useState("");
  const [maxTokens, setMaxTokens] = useState("65536");
  const [contextWindow, setContextWindow] = useState("131072");
  const [error, setError] = useState<string | null>(null);
  const busy = saving || externalBusy;

  useEffect(() => {
    if (!open) return;
    setModelId(editing?.modelId ?? "");
    setName(editing?.name ?? "");
    setType(editing?.type ?? "llm");
    setTemperature(editing?.temperature?.toString() ?? "");
    setTopP(editing?.topP?.toString() ?? "");
    setMaxTokens(editing?.maxTokens?.toString() ?? "65536");
    setContextWindow(editing?.contextWindow?.toString() ?? "131072");
    setError(null);
  }, [open, editing]);

  if (!open) return null;

  async function handleSubmit() {
    if (busy) return;
    const values = {
      modelId,
      name,
      type,
      temperature,
      topP,
      maxTokens,
      contextWindow,
    };
    const result = buildModelSave(providerId, values, editing?.id);
    if (!result.ok) {
      if (result.error !== "required") setError(result.error);
      return;
    }
    const item = { ...result.item, enabled: editing?.enabled ?? true };
    if (await saveModel(item)) onClose();
    else notifySaveFailure(t);
  }

  return (
    <DialogShell
      title={t(editing ? "providers:editModel" : "providers:addModel")}
      busy={busy}
      onClose={onClose}
      footer={
        <FormFooter
          busy={busy}
          confirmDisabled={!modelId.trim()}
          onConfirm={() => void handleSubmit()}
          onCancel={onClose}
          deleteLabel={editing ? t("providers:deleteModel") : undefined}
          onDelete={editing ? () => onDelete(editing) : undefined}
        />
      }
    >
      <FormField
        label={t("providers:modelId")}
        value={modelId}
        onChangeText={setModelId}
      />
      <FormField
        label={t("providers:displayName")}
        value={name}
        onChangeText={setName}
      />
      <View className="gap-1.5">
        <Text className="text-xs text-label2 dark:text-[#EBEBF599]">
          {t("providers:type")}
        </Text>
        <ModelTypeSegments value={type} disabled={busy} onChange={setType} />
      </View>
      {type === "llm" && (
        <View className="gap-4">
          <FormField
            label={t("providers:temperature")}
            value={temperature}
            onChangeText={setTemperature}
            keyboardType="decimal-pad"
          />
          <FormField
            label={t("providers:topP")}
            value={topP}
            onChangeText={setTopP}
            keyboardType="decimal-pad"
          />
          <FormField
            label={t("providers:maxTokens")}
            value={maxTokens}
            onChangeText={setMaxTokens}
            keyboardType="number-pad"
          />
          <FormField
            label={t("providers:contextWindow")}
            value={contextWindow}
            onChangeText={setContextWindow}
            keyboardType="number-pad"
          />
        </View>
      )}
      {error && <Text className="text-xs text-red-500">{t(error)}</Text>}
    </DialogShell>
  );
}

function RemoteImportSheet({
  providerId,
  rows,
  onClose,
}: {
  providerId: number;
  rows: RemoteModelChoice[];
  onClose: () => void;
}) {
  const { t } = useTranslation(["providers", "common"]);
  const colors = useThemeColors();
  const saving = useProvidersStore((state) => state.saving);
  const saveModel = useProvidersStore((state) => state.saveModel);
  const [selected, setSelected] = useState<Set<string>>(
    () =>
      new Set(rows.filter((row) => !row.imported).map((row) => row.modelId)),
  );
  const [importing, setImporting] = useState(false);
  const [importedIds, setImportedIds] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [importResult, setImportResult] = useState<{
    succeeded: number;
    failed: number;
  } | null>(null);
  const busy = saving || importing;
  const keyword = query.trim().toLowerCase();
  const filteredRows = keyword
    ? rows.filter((row) => row.modelId.toLowerCase().includes(keyword))
    : rows;
  const available = filteredRows.filter(
    (row) => !row.imported && !importedIds.has(row.modelId),
  );
  const allSelected =
    available.length > 0 && available.every((row) => selected.has(row.modelId));

  function toggle(modelId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      return next;
    });
  }

  async function handleImport() {
    if (busy || selected.size === 0) return;
    setImporting(true);
    setImportResult(null);
    let failureMessage: string | null | undefined;
    try {
      const result = await importRemoteModels(
        providerId,
        rows,
        selected,
        async (item) => {
          const saved = await saveModel(item);
          if (!saved && failureMessage === undefined) {
            failureMessage = useProvidersStore.getState().error;
          }
          return saved;
        },
      );
      setImportedIds((current) => new Set([...current, ...result.succeeded]));
      setSelected(new Set(result.failed));
      if (result.failed.size > 0) {
        setImportResult({
          succeeded: result.succeeded.size,
          failed: result.failed.size,
        });
        notifySaveFailure(t, failureMessage);
        return;
      }
      onClose();
    } finally {
      setImporting(false);
    }
  }

  return (
    <DialogShell
      title={t("providers:fetchRemote")}
      busy={busy}
      onClose={onClose}
      footer={
        <View className="mt-5 flex-row gap-3 border-t border-sep px-5 py-4 dark:border-[#545458A6]">
          <Pressable
            disabled={busy}
            onPress={onClose}
            className="flex-1 items-center rounded-lg border border-sep py-2.5 dark:border-[#545458A6]"
          >
            <Text className="text-sm text-label2 dark:text-[#EBEBF599]">
              {t("common:cancel")}
            </Text>
          </Pressable>
          <Pressable
            disabled={busy || selected.size === 0}
            onPress={() => void handleImport()}
            className="flex-1 items-center rounded-lg py-2.5"
            style={{
              backgroundColor: colors.primary,
              opacity: busy || selected.size === 0 ? 0.4 : 1,
            }}
          >
            <Text className="text-sm font-medium text-white">
              {t("providers:importCount", { count: selected.size })}
            </Text>
          </Pressable>
        </View>
      }
    >
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder={t("providers:searchPlaceholder")}
        placeholderTextColor={PLACEHOLDER}
        autoCapitalize="none"
        autoCorrect={false}
        className="rounded-lg border border-sep bg-field px-3 py-2 text-sm text-black dark:border-[#545458A6] dark:bg-[#2C2C2E] dark:text-white"
      />
      <View className="flex-row items-center justify-between">
        <Text className="text-xs text-label2 dark:text-[#EBEBF599]">
          {t("providers:modelsCount", { count: filteredRows.length })}
        </Text>
        <Pressable
          disabled={busy || available.length === 0}
          onPress={() =>
            setSelected(
              allSelected
                ? new Set()
                : new Set(available.map((r) => r.modelId)),
            )
          }
          hitSlop={8}
        >
          <Text className="text-sm" style={{ color: colors.primary }}>
            {t("providers:selectAll")}
          </Text>
        </Pressable>
      </View>
      {importResult && (
        <Text className="text-xs text-red-500">
          {t("providers:importPartial", importResult)}
        </Text>
      )}
      {rows.length === 0 ? (
        <Text className="py-8 text-center text-sm text-label2 dark:text-[#EBEBF599]">
          {t("providers:noRemoteModels")}
        </Text>
      ) : filteredRows.length === 0 ? (
        <Text className="py-8 text-center text-sm text-label2 dark:text-[#EBEBF599]">
          {t("providers:noSearchMatch")}
        </Text>
      ) : (
        <View className="gap-2">
          {filteredRows.map((row) => {
            const checked = selected.has(row.modelId);
            const imported = row.imported || importedIds.has(row.modelId);
            return (
              <Pressable
                key={row.modelId}
                disabled={busy || imported}
                onPress={() => toggle(row.modelId)}
                className="flex-row items-center gap-3 rounded-xl bg-card px-3 py-3 dark:bg-[#1C1C1E]"
                style={{ opacity: imported ? 0.45 : 1 }}
              >
                <View className="min-w-0 flex-1">
                  <Text
                    numberOfLines={1}
                    className="text-sm text-black dark:text-white"
                  >
                    {row.name?.trim() || row.modelId}
                  </Text>
                  {row.name?.trim() && (
                    <Text
                      numberOfLines={1}
                      className="mt-0.5 text-xs text-label2 dark:text-[#EBEBF599]"
                    >
                      {row.modelId}
                    </Text>
                  )}
                </View>
                {imported ? (
                  <Text className="text-xs text-label2 dark:text-[#EBEBF599]">
                    {t("providers:imported")}
                  </Text>
                ) : (
                  <View
                    className="h-5 w-5 items-center justify-center rounded border border-sep dark:border-[#545458A6]"
                    style={{
                      borderColor: checked ? colors.primary : undefined,
                      backgroundColor: checked ? colors.primary : undefined,
                    }}
                  >
                    {checked && <Check size={14} color="white" />}
                  </View>
                )}
              </Pressable>
            );
          })}
        </View>
      )}
    </DialogShell>
  );
}

export default function ProvidersScreen() {
  const { t } = useTranslation(["providers", "common"]);
  const colors = useThemeColors();
  const activeConnId = useConnectionsStore((state) => state.activeConnId);
  const capabilities = useConnectionCapabilities(activeConnId);
  const bundle = useProvidersStore((state) => state.bundle);
  const loading = useProvidersStore((state) => state.loading);
  const saving = useProvidersStore((state) => state.saving);
  const error = useProvidersStore((state) => state.error);
  const load = useProvidersStore((state) => state.load);
  const saveProvider = useProvidersStore((state) => state.saveProvider);
  const saveModel = useProvidersStore((state) => state.saveModel);
  const removeProviders = useProvidersStore((state) => state.removeProviders);
  const removeModels = useProvidersStore((state) => state.removeModels);
  const fetchRemote = useProvidersStore((state) => state.fetchRemote);
  const testProvider = useProvidersStore((state) => state.testProvider);
  const [selectedProviderId, setSelectedProviderId] = useState<number | null>(
    null,
  );
  const [providerOpen, setProviderOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<ProviderRow | null>(
    null,
  );
  const [modelOpen, setModelOpen] = useState(false);
  const [editingModel, setEditingModel] = useState<ModelRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [testingTarget, setTestingTarget] = useState<string | null>(null);
  const [remote, setRemote] = useState<{
    providerId: number;
    rows: RemoteModelChoice[];
  } | null>(null);
  const supported = capabilities?.includes("provider") ?? false;
  const busy = saving || deleting || fetching || testingTarget !== null;
  const providers = bundle?.providers ?? [];
  const selectedProvider =
    providers.find((provider) => provider.id === selectedProviderId) ?? null;
  const selectedModels = useMemo(
    () =>
      bundle?.models.filter(
        (model) => model.providerId === selectedProviderId,
      ) ?? [],
    [bundle, selectedProviderId],
  );

  useEffect(() => {
    setSelectedProviderId(null);
    setRemote(null);
    if (activeConnId && supported) void load();
  }, [activeConnId, supported, load]);

  function openProvider(provider: ProviderRow | null) {
    setEditingProvider(provider);
    setProviderOpen(true);
  }

  function openModel(model: ModelRow | null) {
    setEditingModel(model);
    setModelOpen(true);
  }

  async function toggleProvider(provider: ProviderRow, enabled: boolean) {
    if (busy) return;
    const saved = await saveProvider({ ...provider, enabled });
    if (!saved) notifySaveFailure(t);
  }

  async function toggleModel(model: ModelRow, enabled: boolean) {
    if (busy) return;
    const saved = await saveModel({ ...model, enabled });
    if (!saved) notifySaveFailure(t);
  }

  async function deleteProvider(provider: ProviderRow) {
    setDeleting(true);
    try {
      const removed = await removeProviders([provider.id]);
      if (removed) setSelectedProviderId(null);
      else notifySaveFailure(t);
    } finally {
      setDeleting(false);
    }
  }

  function confirmDeleteProvider(provider: ProviderRow) {
    Alert.alert(
      t("providers:deleteProvider"),
      t("providers:deleteProviderConfirm"),
      [
        { text: t("common:cancel"), style: "cancel" },
        {
          text: t("providers:deleteProvider"),
          style: "destructive",
          onPress: () => void deleteProvider(provider),
        },
      ],
    );
  }

  async function deleteModel(model: ModelRow) {
    setDeleting(true);
    try {
      const removed = await removeModels([model.id]);
      if (removed) setModelOpen(false);
      else notifySaveFailure(t);
    } finally {
      setDeleting(false);
    }
  }

  function confirmDeleteModel(model: ModelRow) {
    Alert.alert(
      t("providers:deleteModel"),
      t("providers:deleteModelConfirm", {
        name: model.name?.trim() || model.modelId,
      }),
      [
        { text: t("common:cancel"), style: "cancel" },
        {
          text: t("providers:deleteModel"),
          style: "destructive",
          onPress: () => void deleteModel(model),
        },
      ],
    );
  }

  async function handleTest(providerId: number, target: string) {
    if (busy) return;
    setTestingTarget(target);
    try {
      const result = await testProvider(providerId);
      if (result?.ok) {
        toast.info(t("providers:testOk"));
      } else {
        toast.error(
          result?.message ||
            useProvidersStore.getState().error ||
            t("providers:loadFailed"),
        );
      }
    } finally {
      setTestingTarget(null);
    }
  }

  async function handleFetchRemote(provider: ProviderRow) {
    if (busy) return;
    setFetching(true);
    try {
      const result = await fetchRemote(provider.id);
      if (!result?.success) {
        toast.error(
          result?.message ||
            useProvidersStore.getState().error ||
            t("providers:loadFailed"),
        );
        return;
      }
      const currentModels = useProvidersStore.getState().bundle?.models ?? [];
      const existingIds = new Set(
        currentModels
          .filter((model) => model.providerId === provider.id)
          .map((model) => model.modelId),
      );
      setRemote({
        providerId: provider.id,
        rows: prepareRemoteModels(result.models, existingIds),
      });
    } finally {
      setFetching(false);
    }
  }

  function renderContent() {
    if (!activeConnId || !supported) {
      return (
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-center text-sm text-label2 dark:text-[#EBEBF599]">
            {t("providers:noConnection")}
          </Text>
        </View>
      );
    }
    if (loading || (!bundle && !error)) {
      return (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color={colors.primary} size="large" />
        </View>
      );
    }
    if (!bundle && error) {
      return (
        <View className="flex-1 items-center justify-center gap-3 px-6">
          <Text className="text-sm text-label2 dark:text-[#EBEBF599]">
            {t("providers:loadFailed")}
          </Text>
          <Text className="text-center text-xs text-label3 dark:text-[#EBEBF54D]">
            {error}
          </Text>
          <Pressable
            onPress={() => void load()}
            className="rounded-lg px-4 py-2"
            style={{ backgroundColor: colors.primary }}
          >
            <Text className="text-sm text-white">{t("providers:retry")}</Text>
          </Pressable>
        </View>
      );
    }
    return (
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 16 }}
      >
        {providers.length === 0 ? (
          <Text className="py-20 text-center text-sm text-label2 dark:text-[#EBEBF599]">
            {t("providers:empty")}
          </Text>
        ) : (
          <GroupSection label={t("providers:title")}>
            {providers.map((provider) => (
              <ListItem
                key={provider.id}
                title={provider.name}
                subtitle={provider.type}
                showChevron={false}
                onPress={
                  busy
                    ? undefined
                    : () =>
                        setSelectedProviderId((current) =>
                          current === provider.id ? null : provider.id,
                        )
                }
                right={
                  <View className="items-end gap-0.5">
                    <Text className="text-xs text-label2 dark:text-[#EBEBF599]">
                      {t("providers:modelsCount", {
                        count: (bundle?.models ?? []).filter(
                          (model) => model.providerId === provider.id,
                        ).length,
                      })}
                    </Text>
                    {!provider.enabled && (
                      <Text className="text-[11px] text-label2 dark:text-[#EBEBF599]">
                        {t("providers:disabled")}
                      </Text>
                    )}
                  </View>
                }
              />
            ))}
          </GroupSection>
        )}

        {selectedProvider && (
          <>
            <GroupSection label={selectedProvider.name}>
              <ListItem
                title={t("providers:baseUrl")}
                subtitle={selectedProvider.baseUrl}
                showChevron={false}
              />
              <ListItem
                title={t("providers:apiKey")}
                showChevron={false}
                right={
                  <Text className="text-sm text-label2 dark:text-[#EBEBF599]">
                    {selectedProvider.apiKey
                      ? t("providers:apiKeyConfigured")
                      : "—"}
                  </Text>
                }
              />
              <ListItem
                title={t("providers:enabled")}
                showChevron={false}
                right={
                  <Switch
                    value={selectedProvider.enabled}
                    disabled={busy}
                    onValueChange={(enabled) =>
                      void toggleProvider(selectedProvider, enabled)
                    }
                    trackColor={{ false: colors.subtle, true: colors.primary }}
                    ios_backgroundColor={colors.subtle}
                  />
                }
              />
              <ListItem
                title={t("providers:editProvider")}
                onPress={
                  busy ? undefined : () => openProvider(selectedProvider)
                }
              />
              <ListItem
                icon={<Trash2 size={17} color={DANGER} />}
                title={t("providers:deleteProvider")}
                showChevron={false}
                onPress={
                  busy
                    ? undefined
                    : () => confirmDeleteProvider(selectedProvider)
                }
              />
              <ListItem
                title={t(
                  testingTarget === `provider:${selectedProvider.id}`
                    ? "providers:testing"
                    : "providers:test",
                )}
                showChevron={false}
                onPress={
                  busy
                    ? undefined
                    : () =>
                        void handleTest(
                          selectedProvider.id,
                          `provider:${selectedProvider.id}`,
                        )
                }
                right={
                  testingTarget === `provider:${selectedProvider.id}` ? (
                    <ActivityIndicator color={colors.primary} size="small" />
                  ) : undefined
                }
              />
              <ListItem
                title={t(
                  fetching ? "providers:fetching" : "providers:fetchRemote",
                )}
                showChevron={false}
                onPress={
                  busy
                    ? undefined
                    : () => void handleFetchRemote(selectedProvider)
                }
                right={
                  fetching ? (
                    <ActivityIndicator color={colors.primary} size="small" />
                  ) : undefined
                }
              />
            </GroupSection>

            <GroupSection label={t("providers:models")}>
              {selectedModels.map((model) => (
                <ListItem
                  key={model.id}
                  title={model.name?.trim() || model.modelId}
                  subtitle={model.modelId}
                  onPress={busy ? undefined : () => openModel(model)}
                  right={
                    <View className="flex-row items-center gap-3">
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t("providers:test")}
                        disabled={busy}
                        onPress={(event) => {
                          event.stopPropagation();
                          void handleTest(
                            model.providerId,
                            `model:${model.id}`,
                          );
                        }}
                        hitSlop={8}
                      >
                        {testingTarget === `model:${model.id}` ? (
                          <ActivityIndicator
                            color={colors.primary}
                            size="small"
                          />
                        ) : (
                          <Text
                            className="text-sm"
                            style={{ color: colors.primary }}
                          >
                            {t("providers:test")}
                          </Text>
                        )}
                      </Pressable>
                      <Switch
                        value={model.enabled}
                        disabled={busy}
                        onValueChange={(enabled) =>
                          void toggleModel(model, enabled)
                        }
                        trackColor={{
                          false: colors.subtle,
                          true: colors.primary,
                        }}
                        ios_backgroundColor={colors.subtle}
                      />
                    </View>
                  }
                />
              ))}
              <ListItem
                icon={<Plus size={17} color={colors.primary} />}
                title={t("providers:addModel")}
                showChevron={false}
                onPress={busy ? undefined : () => openModel(null)}
              />
            </GroupSection>
          </>
        )}
      </ScrollView>
    );
  }

  return (
    <SafeAreaView
      className="flex-1 bg-grouped dark:bg-black"
      edges={["top", "bottom"]}
    >
      <PageHeader
        title={t("providers:title")}
        backLabel={t("providers:back")}
        right={
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("providers:addProvider")}
            disabled={!supported || busy}
            onPress={() => openProvider(null)}
            hitSlop={12}
            className="h-9 w-9 items-center justify-center rounded-full"
            style={({ pressed }) => ({
              backgroundColor: pressed ? colors.subtle : undefined,
              opacity: !supported || busy ? 0.4 : 1,
            })}
          >
            <MessageSquarePlus size={17} color={colors.primary} />
          </Pressable>
        }
      />
      {renderContent()}
      <ProviderDialog
        open={providerOpen}
        editing={editingProvider}
        onClose={() => setProviderOpen(false)}
      />
      {selectedProvider && (
        <ModelDialog
          open={modelOpen}
          providerId={selectedProvider.id}
          editing={editingModel}
          externalBusy={deleting || fetching}
          onClose={() => setModelOpen(false)}
          onDelete={confirmDeleteModel}
        />
      )}
      {remote && (
        <RemoteImportSheet
          providerId={remote.providerId}
          rows={remote.rows}
          onClose={() => setRemote(null)}
        />
      )}
    </SafeAreaView>
  );
}

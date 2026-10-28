/**
 * 添加/编辑连接对话框（T17）：mode 切换字段集（direct=baseUrl+token+
 * backupToken（备份专用 token，多用户批：可选，申领成功自动回填）/
 * relay=relayUrl+relayToken+connectionId+fingerprint+e2eMode——E2E 指纹可选
 * 空=TOFU 首连回填、E2E 模式 auto/required（required=握手无 ack 拒降级断开，
 * E2E-T4/T3 审查），E2E-T3/T4），必填与 URL 形态校验（与主进程
 * validateConfig 同口径——渲染层先拦，主进程兜底），「测试连接」用当前表单
 * 草稿走临时 transport（不落库）；保存走 server:connectionSave。
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, PlugZap } from "lucide-react";

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
import ServerApi, {
  newConnectionId,
  type ConnectionConfig,
  type ConnectionE2eMode,
  type ConnectionMode,
  type TestConnectionResult,
} from "../api/server.api";

export const CONNECTIONS_QUERY_KEY = ["server", "connections"] as const;

/** 表单草稿（编辑时以 initial 填充；id 新建时生成避开 ":"） */
interface ConnectionDraft {
  id: string;
  name: string;
  mode: ConnectionMode;
  baseUrl: string;
  token: string;
  /** 备份专用 token（多用户批：可选；申领成功自动回填，通常零手填） */
  backupToken: string;
  relayUrl: string;
  relayToken: string;
  connectionId: string;
  fingerprint: string;
  e2eMode: ConnectionE2eMode;
}

const EMPTY_DRAFT: ConnectionDraft = {
  id: "",
  name: "",
  mode: "direct",
  baseUrl: "",
  token: "",
  backupToken: "",
  relayUrl: "",
  relayToken: "",
  connectionId: "",
  fingerprint: "",
  e2eMode: "auto",
};

function draftFrom(initial: ConnectionConfig | null): ConnectionDraft {
  if (!initial) return { ...EMPTY_DRAFT, id: newConnectionId() };
  return {
    id: initial.id,
    name: initial.name,
    mode: initial.mode,
    baseUrl: initial.baseUrl ?? "",
    token: initial.token ?? "",
    backupToken: initial.backupToken ?? "",
    relayUrl: initial.relayUrl ?? "",
    relayToken: initial.relayToken ?? "",
    connectionId: initial.connectionId ?? "",
    fingerprint: initial.fingerprint ?? "",
    e2eMode: initial.e2eMode ?? "auto",
  };
}

/** 按表单草稿组装连接配置（token/fingerprint 可选透传——指纹归一小写） */
function draftToConfig(draft: ConnectionDraft): ConnectionConfig {
  const config: ConnectionConfig = {
    id: draft.id,
    name: draft.name.trim(),
    mode: draft.mode,
  };
  if (draft.mode === "direct") {
    config.baseUrl = draft.baseUrl.trim().replace(/\/+$/, "");
    if (draft.token.trim()) config.token = draft.token.trim();
    // 备份专用 token 可选透传（申领自动回填后经此链原样保留——编辑
    // 未动该字段即不丢身份）
    if (draft.backupToken.trim()) config.backupToken = draft.backupToken.trim();
  } else {
    config.relayUrl = draft.relayUrl.trim();
    config.relayToken = draft.relayToken.trim();
    config.connectionId = draft.connectionId.trim();
    config.e2eMode = draft.e2eMode;
    if (draft.fingerprint.trim()) {
      config.fingerprint = draft.fingerprint.trim().toLowerCase();
    }
  }
  return config;
}

/** 必填/形态校验：错误消息 i18n key（empty=名称/mode 缺失等守卫） */
function validateDraft(
  draft: ConnectionDraft,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  if (!draft.name.trim()) return t("ai:server.connection.errors.nameRequired");
  if (draft.mode === "direct") {
    if (!/^https?:\/\//.test(draft.baseUrl.trim())) {
      return t("ai:server.connection.errors.baseUrlInvalid");
    }
  } else {
    if (!/^wss?:\/\//.test(draft.relayUrl.trim())) {
      return t("ai:server.connection.errors.relayUrlInvalid");
    }
    if (!draft.relayToken.trim()) {
      return t("ai:server.connection.errors.relayTokenRequired");
    }
    if (!draft.connectionId.trim()) {
      return t("ai:server.connection.errors.connectionIdRequired");
    }
    // 指纹可选但须形态合法（16 位十六进制——被控端设置卡可复制）
    if (
      draft.fingerprint.trim() &&
      !/^[0-9a-f]{16}$/i.test(draft.fingerprint.trim())
    ) {
      return t("ai:server.e2e.fingerprintInvalid");
    }
  }
  return null;
}

/** 测试失败 reason → i18n 文案 */
function describeTestFailure(
  result: Extract<TestConnectionResult, { ok: false }>,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const reasonKey = {
    "invalid-config": "invalidConfig",
    "invalid-token": "invalidToken",
    unreachable: "unreachable",
    timeout: "timeout",
  }[result.reason];
  return t(`ai:server.connection.testReason.${reasonKey}`);
}

export interface ConnectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 编辑既有连接；null=新建 */
  initial?: ConnectionConfig | null;
  onSaved?: (id: string) => void;
}

export function ConnectionDialog({
  open,
  onOpenChange,
  initial = null,
  onSaved,
}: ConnectionDialogProps) {
  const { t } = useTranslation(["ai", "common"]);
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ConnectionDraft>(draftFrom(initial));
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  // 开对话框时重置草稿（编辑 → initial；新建 → 新 id）
  useEffect(() => {
    if (open) {
      setDraft(draftFrom(initial));
      setError(null);
    }
  }, [open, initial]);

  const patch = (partial: Partial<ConnectionDraft>) =>
    setDraft((prev) => ({ ...prev, ...partial }));

  /** 测试连接：表单草稿（先过校验）→ 临时 transport GET info */
  const handleTest = async () => {
    const invalid = validateDraft(draft, t);
    if (invalid) {
      setError(invalid);
      return;
    }
    setTesting(true);
    setError(null);
    try {
      const result = await ServerApi.testConnection(draftToConfig(draft));
      if (result.ok) {
        toast.success(
          t("ai:server.connection.testOk", { instance: result.instanceId }),
        );
      } else {
        toast.error(
          t("ai:server.connection.testFailed", {
            reason: describeTestFailure(result, t),
          }),
        );
      }
    } catch (e) {
      toast.error(t("ai:server.connection.testError", { message: String(e) }));
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    const invalid = validateDraft(draft, t);
    if (invalid) {
      setError(invalid);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await ServerApi.saveConnection(draftToConfig(draft));
      await queryClient.invalidateQueries({ queryKey: CONNECTIONS_QUERY_KEY });
      onSaved?.(draft.id);
      onOpenChange(false);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border border-border/50 rounded-lg shadow-lg sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {initial
              ? t("ai:server.connection.edit")
              : t("ai:server.connection.add")}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          {/* 基本信息：名称 + 连接方式（HD-P3c 布局分组——字段按语义分区，
              组标题弱化层级，替代原平铺堆叠） */}
          <p className="pt-1 text-xs font-medium text-muted-foreground">
            {t("ai:server.connection.groupBasic")}
          </p>
          <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2.5">
            <Label htmlFor="conn-name" className="whitespace-nowrap">
              {t("ai:server.connection.name")}
            </Label>
            <Input
              id="conn-name"
              data-testid="conn-name"
              value={draft.name}
              onChange={(e) => patch({ name: e.target.value })}
              placeholder={t("ai:server.connection.namePlaceholder")}
            />
            <Label className="whitespace-nowrap">
              {t("ai:server.connection.mode")}
            </Label>
            <Select
              value={draft.mode}
              onValueChange={(mode) => patch({ mode: mode as ConnectionMode })}
            >
              <SelectTrigger data-testid="conn-mode" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border border-border/50 rounded-lg shadow-lg">
                <SelectItem value="direct">
                  {t("ai:server.connection.modeDirect")}
                </SelectItem>
                <SelectItem value="relay">
                  {t("ai:server.connection.modeRelay")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {draft.mode === "direct" ? (
            <>
              <p className="pt-2.5 text-xs font-medium text-muted-foreground">
                {t("ai:server.connection.groupDirect")}
              </p>
              <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2.5">
                <Label
                  htmlFor="conn-base-url"
                  className="whitespace-nowrap text-right"
                >
                  {t("ai:server.connection.baseUrl")}
                </Label>
                <Input
                  id="conn-base-url"
                  data-testid="conn-base-url"
                  value={draft.baseUrl}
                  onChange={(e) => patch({ baseUrl: e.target.value })}
                  placeholder="http://127.0.0.1:3000"
                />
                <Label
                  htmlFor="conn-token"
                  className="whitespace-nowrap text-right"
                >
                  {t("ai:server.connection.token")}
                </Label>
                <Input
                  id="conn-token"
                  data-testid="conn-token"
                  type="password"
                  value={draft.token}
                  onChange={(e) => patch({ token: e.target.value })}
                  placeholder={t("ai:server.connection.tokenPlaceholder")}
                />
                <Label
                  htmlFor="conn-backup-token"
                  className="whitespace-nowrap text-right"
                >
                  {t("ai:server.connection.backupToken")}
                </Label>
                <Input
                  id="conn-backup-token"
                  data-testid="conn-backup-token"
                  type="password"
                  value={draft.backupToken}
                  onChange={(e) => patch({ backupToken: e.target.value })}
                  placeholder={t("ai:server.connection.backupTokenPlaceholder")}
                />
              </div>
              <p className="text-[10px] leading-relaxed text-muted-foreground/80">
                {t("ai:server.connection.backupTokenHint")}
              </p>
            </>
          ) : (
            <>
              <p className="pt-2.5 text-xs font-medium text-muted-foreground">
                {t("ai:server.connection.groupRelay")}
              </p>
              <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2.5">
                <Label
                  htmlFor="conn-relay-url"
                  className="whitespace-nowrap text-right"
                >
                  {t("ai:server.connection.relayUrl")}
                </Label>
                <Input
                  id="conn-relay-url"
                  data-testid="conn-relay-url"
                  value={draft.relayUrl}
                  onChange={(e) => patch({ relayUrl: e.target.value })}
                  placeholder="ws://127.0.0.1:18412/ws"
                />
                <Label
                  htmlFor="conn-relay-token"
                  className="whitespace-nowrap text-right"
                >
                  {t("ai:server.connection.relayToken")}
                </Label>
                <Input
                  id="conn-relay-token"
                  data-testid="conn-relay-token"
                  value={draft.relayToken}
                  onChange={(e) => patch({ relayToken: e.target.value })}
                />
                <Label
                  htmlFor="conn-target"
                  className="whitespace-nowrap text-right"
                >
                  {t("ai:server.connection.connectionId")}
                </Label>
                <Input
                  id="conn-target"
                  data-testid="conn-target"
                  value={draft.connectionId}
                  onChange={(e) => patch({ connectionId: e.target.value })}
                  placeholder={t(
                    "ai:server.connection.connectionIdPlaceholder",
                  )}
                />
              </div>
              {/* E2E（E2E-T3/T4）：指纹空=TOFU 首连回填；mode required=
                  握手无 ack 拒降级断开 */}
              <p className="pt-2.5 text-xs font-medium text-muted-foreground">
                {t("ai:server.e2e.groupTitle")}
              </p>
              <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2.5">
                <Label
                  htmlFor="conn-fingerprint"
                  className="whitespace-nowrap text-right"
                >
                  {t("ai:server.e2e.fingerprint")}
                </Label>
                <Input
                  id="conn-fingerprint"
                  data-testid="conn-fingerprint"
                  className="font-mono"
                  value={draft.fingerprint}
                  onChange={(e) => patch({ fingerprint: e.target.value })}
                  placeholder={t("ai:server.e2e.fingerprintPlaceholder")}
                />
                <Label className="whitespace-nowrap text-right">
                  {t("ai:server.e2e.mode")}
                </Label>
                <Select
                  value={draft.e2eMode}
                  onValueChange={(e2eMode) =>
                    patch({ e2eMode: e2eMode as ConnectionE2eMode })
                  }
                >
                  <SelectTrigger data-testid="conn-e2e-mode" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="border border-border/50 rounded-lg shadow-lg">
                    <SelectItem value="auto">
                      {t("ai:server.e2e.modeAuto")}
                    </SelectItem>
                    <SelectItem value="required">
                      {t("ai:server.e2e.modeRequired")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <p className="text-[10px] leading-relaxed text-muted-foreground/80">
                {t("ai:server.e2e.fingerprintHint")}
              </p>
            </>
          )}
          {error && (
            <p
              data-testid="conn-error"
              className="pt-1 text-xs text-destructive"
            >
              {error}
            </p>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            size="sm"
            className="mr-auto hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
            disabled={testing || saving}
            onClick={() => void handleTest()}
          >
            {testing ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <PlugZap className="mr-1 h-3.5 w-3.5" />
            )}
            {testing
              ? t("ai:server.connection.testing")
              : t("ai:server.connection.test")}
          </Button>
          <Button
            size="sm"
            data-testid="conn-save"
            disabled={testing || saving}
            onClick={() => void handleSave()}
          >
            {saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            {t("common:save")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={testing || saving}
          >
            {t("common:cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

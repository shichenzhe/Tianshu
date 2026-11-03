import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, TextInput, View } from "react-native";

import { PressableButton } from "@/components/PressableButton";
import { toast } from "@/lib/toast-bus";
import { kebabToPascal } from "@/lib/str";
import {
  isValidConfig,
  testConnection,
  validateRelayUrlScheme,
  useConnectionsStore,
  type ConnectionConfig,
} from "@/store/connections.store";

interface Props {
  /** 编辑态回填；缺省为新建 */
  initial?: ConnectionConfig;
  /** 新建时的初始模式（页面「添加直连/添加中继」入口预置；编辑态被 initial.mode 覆盖） */
  defaultMode?: "direct" | "relay";
  onDone: () => void;
}

/** 表单内单行文本字段（label + 输入框；token 类 secureTextEntry） */
function TextField({
  label,
  value,
  onChange,
  secure = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  secure?: boolean;
}) {
  return (
    <View className="mb-3">
      <Text className="mb-1 text-[13px] text-label2 dark:text-[#EBEBF599]">
        {label}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        accessibilityLabel={label}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        secureTextEntry={secure}
        className="min-h-11 rounded-lg border border-black/15 px-3 py-2 text-[15px] text-black dark:border-[#545458A6] dark:text-white"
      />
    </View>
  );
}

/**
 * 连接编辑表单（T12）：direct/relay 双模式切换；测试/保存反馈走自绘
 * toast（ok → info 带 instanceId；fail → error 归因四分类；1414fe9a 轻提
 * 示体系迁移时本页漏迁，内联小灰字键盘遮挡近乎不可见，2026-10-22 补）；
 * 保存经 isValidConfig 门禁后入库、toast 确认再关弹层。
 */
export function ConnectionForm({ initial, defaultMode, onDone }: Props) {
  const { t } = useTranslation();
  const save = useConnectionsStore((s) => s.save);
  const activate = useConnectionsStore((s) => s.activate);
  const activeConnId = useConnectionsStore((s) => s.activeConnId);
  const [mode, setMode] = useState<"direct" | "relay">(
    initial?.mode ?? defaultMode ?? "direct",
  );
  const [name, setName] = useState(initial?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [token, setToken] = useState(initial?.token ?? "");
  const [relayUrl, setRelayUrl] = useState(initial?.relayUrl ?? "");
  const [relayToken, setRelayToken] = useState(initial?.relayToken ?? "");
  const [connectionId, setConnectionId] = useState(initial?.connectionId ?? "");
  // —— relay AK 凭证（多租户 T16）：与中继令牌二选一，static 优先 ——
  const [adminUrl, setAdminUrl] = useState(initial?.adminUrl ?? "");
  const [akId, setAkId] = useState(initial?.akId ?? "");
  const [akSecret, setAkSecret] = useState(initial?.akSecret ?? "");
  // —— relay e2e（安全批 H）：模式两段 + TOFU 指纹（编辑态回填） ——
  const [e2eMode, setE2eMode] = useState<"auto" | "required">(
    initial?.e2eMode ?? "auto",
  );
  const [fingerprint, setFingerprint] = useState(initial?.fingerprint ?? "");
  const [testing, setTesting] = useState(false);

  const asConfig = (): ConnectionConfig => ({
    id: initial?.id ?? Math.random().toString(36).slice(2),
    name: name.trim() || (mode === "direct" ? baseUrl.trim() : relayUrl.trim()),
    mode,
    ...(mode === "direct"
      ? { baseUrl: baseUrl.trim(), token: token.trim() }
      : {
          relayUrl: relayUrl.trim(),
          relayToken: relayToken.trim(),
          connectionId: connectionId.trim(),
          // AK 三要素逐字段保留（部分填写由 isValidConfig 门禁提示补全）
          ...(adminUrl.trim() ? { adminUrl: adminUrl.trim() } : {}),
          ...(akId.trim() ? { akId: akId.trim() } : {}),
          ...(akSecret.trim() ? { akSecret: akSecret.trim() } : {}),
          ...(fingerprint.trim() ? { fingerprint: fingerprint.trim() } : {}),
          ...(e2eMode === "required" ? { e2eMode } : {}),
        }),
  });

  async function handleTest() {
    if (testing) return;
    setTesting(true);
    const r = await testConnection(asConfig());
    setTesting(false);
    if (r.ok) {
      toast.info(t("connections:testOk", { instance: r.info.instanceId }));
    } else {
      toast.error(t(`connections:reason${kebabToPascal(r.reason)}`));
    }
  }

  function handleSave() {
    const cfg = asConfig();
    // relay 地址 scheme 门禁（安全批 H；桌面批二 B7 同款）：公网/域名明文
    // ws:// 的凭证可被链路嗅探——保存即拒，内网 IP 直连放行
    if (cfg.mode === "relay" && cfg.relayUrl) {
      const scheme = validateRelayUrlScheme(cfg.relayUrl);
      if (scheme !== true) {
        toast.error(
          t(
            scheme === "public-plaintext"
              ? "connections:reasonPublicPlaintext"
              : "connections:reasonInvalidScheme",
          ),
        );
        return;
      }
    }
    if (!isValidConfig(cfg)) {
      toast.error(t("connections:reasonInvalidConfig"));
      return;
    }
    save(cfg);
    // 编辑的是当前活动连接：save 只改配置不动实例，需再 activate 同 id 热重建
    //（activate 恒拆旧建新）才能让新配置生效
    if (initial && activeConnId === initial.id) {
      activate(initial.id);
    }
    toast.info(t("connections:saved"));
    onDone();
  }

  return (
    <View>
      <Text className="mb-4 text-lg font-semibold text-black dark:text-white">
        {initial
          ? t("connections:editTitle")
          : mode === "direct"
            ? t("connections:addDirect")
            : t("connections:addRelay")}
      </Text>

      {/* 模式切换（两段式） */}
      <View className="mb-4 flex-row gap-2">
        {(["direct", "relay"] as const).map((m) => (
          <PressableButton
            key={m}
            label={t(
              m === "direct"
                ? "connections:modeDirect"
                : "connections:modeRelay",
            )}
            onPress={() => setMode(m)}
            variant={mode === m ? "filled" : "plain"}
            selected={mode === m}
            className="flex-1"
          />
        ))}
      </View>

      <TextField
        label={t("connections:name")}
        value={name}
        onChange={setName}
      />
      {mode === "direct" ? (
        <>
          <TextField
            label={t("connections:baseUrl")}
            value={baseUrl}
            onChange={setBaseUrl}
          />
          <TextField
            label={t("connections:token")}
            value={token}
            onChange={setToken}
            secure
          />
        </>
      ) : (
        <>
          <TextField
            label={t("connections:relayUrl")}
            value={relayUrl}
            onChange={setRelayUrl}
          />
          <TextField
            label={t("connections:relayToken")}
            value={relayToken}
            onChange={setRelayToken}
            secure
          />
          <TextField
            label={t("connections:connectionId")}
            value={connectionId}
            onChange={setConnectionId}
          />
          {/* AK 凭证三要素（多租户 T16）：换发短效 access 连接；与中继令牌
              二选一，static 在场零 AK 请求 */}
          <TextField
            label={t("connections:adminUrl")}
            value={adminUrl}
            onChange={setAdminUrl}
          />
          <TextField
            label={t("connections:akId")}
            value={akId}
            onChange={setAkId}
          />
          <TextField
            label={t("connections:akSecret")}
            value={akSecret}
            onChange={setAkSecret}
            secure
          />
          <Text className="-mt-1 mb-3 text-xs text-label2 dark:text-[#EBEBF599]">
            {t("connections:akHint")}
          </Text>
          {/* e2e 模式两段（安全批 H；语义同桌面连接级开关） */}
          <View className="mb-3">
            <Text className="mb-1 text-[13px] text-label2 dark:text-[#EBEBF599]">
              {t("connections:e2eMode")}
            </Text>
            <View className="flex-row gap-2">
              {(["auto", "required"] as const).map((m) => (
                <PressableButton
                  key={m}
                  label={t(
                    m === "auto"
                      ? "connections:e2eAuto"
                      : "connections:e2eRequired",
                  )}
                  onPress={() => setE2eMode(m)}
                  variant={e2eMode === m ? "filled" : "plain"}
                  selected={e2eMode === m}
                  className="flex-1"
                />
              ))}
            </View>
            <Text className="mt-1 text-xs text-label2 dark:text-[#EBEBF599]">
              {t(
                e2eMode === "auto"
                  ? "connections:e2eAutoHint"
                  : "connections:e2eRequiredHint",
              )}
            </Text>
          </View>
          <TextField
            label={t("connections:fingerprint")}
            value={fingerprint}
            onChange={setFingerprint}
          />
        </>
      )}

      <View className="mb-3">
        <PressableButton
          label={testing ? t("connections:testing") : t("connections:test")}
          onPress={handleTest}
          variant="outlined"
          busy={testing}
          className="w-full"
        />
      </View>

      <View className="flex-row gap-3">
        <PressableButton
          label={t("connections:cancel")}
          onPress={onDone}
          variant="plain"
          className="flex-1"
        />
        <PressableButton
          label={t("connections:save")}
          onPress={handleSave}
          variant="filled"
          className="flex-1"
        />
      </View>
    </View>
  );
}

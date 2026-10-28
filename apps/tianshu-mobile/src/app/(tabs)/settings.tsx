import { useState } from "react";

import Constants from "expo-constants";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, Switch, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  BarChart3,
  Building2,
  Check,
  Folder,
  FolderGit2,
  LibraryBig,
  ShieldCheck,
  Store,
  Users,
  Brain,
  HardDriveUpload,
} from "lucide-react-native";
import { useColorScheme } from "nativewind";

import { GroupSection } from "@/components/GroupSection";
import { ListItem } from "@/components/ListItem";
import { McpSection } from "@/components/McpSection";
import { SkillsSection } from "@/components/SkillsSection";
import { StateDot } from "@/components/StateDot";
import { toast } from "@/lib/toast-bus";
import {
  useConnectionsStore,
  useConnectionCapabilities,
} from "@/store/connections.store";
import { setLocale } from "@/i18n";
import { requestNotificationPermission } from "@/lib/notify";
import { useNotifyStore } from "@/store/notify.store";
import { useThemeStore, useThemeColors } from "@/store/theme";
import type { TransportState } from "@/transport/types";
import {
  THEME_PRESETS,
  resolveThemeColors,
  type ThemeMode,
  type ThemeName,
} from "@/theme/colors";

type Locale = "zh-CN" | "en-US";

/** 语言选项（label 走 settings ns：双语下「中文/English」均显示本名） */
const LANGUAGES: Array<{ locale: Locale; labelKey: string }> = [
  { locale: "zh-CN", labelKey: "languageZh" },
  { locale: "en-US", labelKey: "languageEn" },
];

/** 明暗模式选项（system 跟随系统；浅/深手动钉死——设置页主体当前全是
 *  bg-grouped dark:bg-black 双态写法，钉死后即得浅色背景） */
const MODES: Array<{ mode: ThemeMode; labelKey: string }> = [
  { mode: "system", labelKey: "modeSystem" },
  { mode: "light", labelKey: "modeLight" },
  { mode: "dark", labelKey: "modeDark" },
];

/** 主题选项顺序（blue 为缺省在前） */
const THEME_NAMES = Object.keys(THEME_PRESETS) as ThemeName[];

const THEME_LABEL_KEYS: Record<ThemeName, string> = {
  blue: "themeBlue",
  red: "themeRed",
  green: "themeGreen",
  orange: "themeOrange",
};

/** 主题色卡：各用自身主题的 primary/subtle 渲染预览（subtle 按当前明暗取套），
 *  当前项自身 primary 描边 */
function ThemeCard({
  name,
  label,
  selected,
  onPress,
}: {
  name: ThemeName;
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const { colorScheme } = useColorScheme();
  const preset = resolveThemeColors(
    THEME_PRESETS[name],
    colorScheme === "dark" ? "dark" : "light",
  );
  return (
    <Pressable
      onPress={onPress}
      className="flex-1 items-center gap-2 rounded-lg border-2 py-3"
      style={{
        borderColor: selected ? preset.primary : "transparent",
        backgroundColor: preset.subtle,
      }}
    >
      <View
        className="h-8 w-8 rounded-full"
        style={{ backgroundColor: preset.primary }}
      />
      <Text className="text-xs" style={{ color: preset.primaryActive }}>
        {label}
      </Text>
    </Pressable>
  );
}

/** 通知开关行（M3）：label + Switch；disabled 置灰（总开关关时子开关不可用） */
function ToggleRow({
  label,
  value,
  disabled,
  onValueChange,
}: {
  label: string;
  value: boolean;
  disabled?: boolean;
  onValueChange: (next: boolean) => void;
}) {
  const colors = useThemeColors();
  return (
    <View
      className="flex-row items-center rounded-lg border border-sep px-3 py-3 dark:border-[#545458A6]"
      style={{ opacity: disabled ? 0.45 : 1 }}
    >
      <Text className="flex-1 text-sm text-black dark:text-white">{label}</Text>
      <Switch
        value={value}
        disabled={disabled}
        onValueChange={onValueChange}
        trackColor={{ false: "#d4d4d8", true: colors.primary }}
        ios_backgroundColor="#3f3f46"
      />
    </View>
  );
}

/** 设置页（M1）：语言切换（setLocale）+ 主题切换（setTheme，行/卡经 useThemeColors 即时重渲）+ 关于块。
 * M3 增「通知」区：总开关（首次打开请求系统权限，拒绝回弹提示且保持关）+
 * 审批/图完成两个子开关（总开关关时禁用置灰）。 */
export default function SettingsScreen() {
  const { t, i18n } = useTranslation([
    "settings",
    "chat",
    "monitor",
    "providers",
    "library",
    "project",
    "experts",
    "skills",
    "memory",
    "backup",
  ]);
  const router = useRouter();
  const colors = useThemeColors();
  const themeName = useThemeStore((s) => s.themeName);
  const setTheme = useThemeStore((s) => s.setTheme);
  const mode = useThemeStore((s) => s.mode);
  const setMode = useThemeStore((s) => s.setMode);
  const notifyEnabled = useNotifyStore((s) => s.enabled);
  const notifyApprovals = useNotifyStore((s) => s.approvals);
  const notifyGraphDone = useNotifyStore((s) => s.graphDone);
  const setPrefs = useNotifyStore((s) => s.setPrefs);
  // MT-T4：技能段跟随活动连接（切端重拉）
  const activeConnId = useConnectionsStore((s) => s.activeConnId);
  const capabilities = useConnectionCapabilities(activeConnId);
  const configs = useConnectionsStore((s) => s.configs);
  const states = useConnectionsStore((s) => s.states);
  const activeConfig = configs.find((c) => c.id === activeConnId) ?? null;
  const activeState: TransportState | undefined = activeConnId
    ? (states[activeConnId] ?? "idle")
    : undefined;

  // 前缀判定：zh* → 中文，其余归英文（恢复档/默认均为二者之一）
  const currentLocale: Locale = i18n.language.startsWith("zh")
    ? "zh-CN"
    : "en-US";
  const appVersion = Constants.expoConfig?.version ?? "-";

  /** 总开关 pending 态（M4）：权限请求期间禁用该行，拒绝/完成复位——
   * Switch 受控于 store 值，store 未变即视觉回弹 OFF */
  const [notifyPending, setNotifyPending] = useState(false);

  /** 总开关：打开先请求系统通知权限，拒绝则回弹提示且保持关 */
  async function handleNotifyMaster(next: boolean) {
    if (!next) {
      setPrefs({ enabled: false });
      return;
    }
    setNotifyPending(true);
    try {
      const granted = await requestNotificationPermission();
      if (!granted) {
        toast.warning(t("notifyPermissionDenied"));
        return;
      }
      setPrefs({ enabled: true });
    } finally {
      setNotifyPending(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1 }} edges={["top", "bottom"]}>
      <ScrollView
        className="flex-1 bg-grouped dark:bg-black"
        contentContainerStyle={{ padding: 16, gap: 16 }}
      >
        {/* 当前主机卡片：状态点 + 连接名，点击进入连接管理 */}
        <Pressable
          onPress={() => router.push("/connections")}
          className="flex-row items-center gap-3 rounded-2xl bg-card px-4 py-4 dark:bg-[#1C1C1E]"
          style={({ pressed }) => ({
            backgroundColor: pressed ? colors.subtle : undefined,
          })}
        >
          <StateDot state={activeState} />
          <View className="min-w-0 flex-1">
            <Text className="text-[13px] text-label3 dark:text-[#EBEBF54D]">
              {t("currentHost")}
            </Text>
            <Text
              numberOfLines={1}
              className="text-[17px] font-semibold text-black dark:text-white"
            >
              {activeConfig?.name ?? t("chat:noConnection")}
            </Text>
          </View>
        </Pressable>

        <GroupSection label={t("language")}>
          {LANGUAGES.map(({ locale, labelKey }) => (
            <ListItem
              key={locale}
              title={t(labelKey)}
              showChevron={false}
              right={
                currentLocale === locale ? (
                  <Check size={16} color={colors.primary} />
                ) : undefined
              }
              onPress={() => setLocale(locale)}
            />
          ))}
        </GroupSection>

        {/* 明暗模式（T11）：system 跟随系统，浅/深手动钉死——即时生效 */}
        <GroupSection label={t("appearance")}>
          {MODES.map(({ mode: value, labelKey }) => (
            <ListItem
              key={value}
              title={t(labelKey)}
              showChevron={false}
              right={
                mode === value ? (
                  <Check size={16} color={colors.primary} />
                ) : undefined
              }
              onPress={() => setMode(value)}
            />
          ))}
        </GroupSection>

        <GroupSection label={t("theme")}>
          <View className="flex-row gap-3">
            {THEME_NAMES.map((name) => (
              <ThemeCard
                key={name}
                name={name}
                label={t(THEME_LABEL_KEYS[name])}
                selected={themeName === name}
                onPress={() => setTheme(name)}
              />
            ))}
          </View>
        </GroupSection>

        <GroupSection label={t("notifications")}>
          <ToggleRow
            label={t("notifyEnable")}
            value={notifyEnabled}
            disabled={notifyPending}
            onValueChange={(next) => void handleNotifyMaster(next)}
          />
          <ToggleRow
            label={t("notifyApprovals")}
            value={notifyApprovals}
            disabled={!notifyEnabled}
            onValueChange={(next) => setPrefs({ approvals: next })}
          />
          <ToggleRow
            label={t("notifyGraphDone")}
            value={notifyGraphDone}
            disabled={!notifyEnabled}
            onValueChange={(next) => setPrefs({ graphDone: next })}
          />
          <Text className="px-1 text-xs leading-4 text-label3 dark:text-[#EBEBF54D]">
            {t("notifyBackgroundHint")}
          </Text>
        </GroupSection>

        {/* A10 审批记忆（chat 门禁：审批记忆属会话审批域，双端均有
            toolPermission 表/审批运行态） */}
        {capabilities?.includes("chat") && (
          <GroupSection>
            <ListItem
              icon={<ShieldCheck size={20} color={colors.primary} />}
              title={t("permissionEntry")}
              showChevron
              onPress={() => router.push("/permissions")}
            />
          </GroupSection>
        )}

        {/* A6 桌面用量监控（能力门禁：旧被控端/无头端不显示入口） */}
        {capabilities?.includes("monitor") && (
          <GroupSection>
            <ListItem
              icon={<BarChart3 size={20} color={colors.primary} />}
              title={t("monitor:title")}
              showChevron
              onPress={() => router.push("/monitor")}
            />
          </GroupSection>
        )}

        {/* A1 服务商/模型配置（能力门禁：不支持 provider 的主机不显示） */}
        {capabilities?.includes("provider") && (
          <GroupSection>
            <ListItem
              icon={<Building2 size={20} color={colors.primary} />}
              title={t("providers:title")}
              showChevron
              onPress={() => router.push("/providers")}
            />
          </GroupSection>
        )}

        {/* A5 资料库（能力门禁：仅桌面被控端上报 library 能力） */}
        {capabilities?.includes("library") && (
          <GroupSection>
            <ListItem
              icon={<LibraryBig size={20} color={colors.primary} />}
              title={t("library:title")}
              showChevron
              onPress={() => router.push("/library")}
            />
          </GroupSection>
        )}

        {/* A7 项目（能力门禁：仅桌面被控端上报 project 能力） */}
        {capabilities?.includes("project") && (
          <GroupSection>
            <ListItem
              icon={<FolderGit2 size={20} color={colors.primary} />}
              title={t("project:title")}
              showChevron
              onPress={() => router.push("/projects")}
            />
          </GroupSection>
        )}

        {/* A8 工作空间管理（chat 门禁：会话/空间一体的主机可用） */}
        {capabilities?.includes("chat") && (
          <GroupSection>
            <ListItem
              icon={<Folder size={20} color={colors.primary} />}
              title={t("workspaceEntry")}
              showChevron
              onPress={() => router.push("/workspaces")}
            />
          </GroupSection>
        )}

        {/* MT-T4 技能启停（活动连接的远端技能面；无连接/无技能自隐藏） */}
        <SkillsSection refreshKey={activeConnId} />

        {/* A3 技能市场（能力门禁 skillhub——宿主侧安装，零流量；独立页
            范式同专家：入口行进 /skills/market，行点进 /skills/[slug] 详情） */}
        {capabilities?.includes("skillhub") && (
          <GroupSection>
            <ListItem
              icon={<Store size={20} color={colors.primary} />}
              title={t("skills:marketTitle")}
              showChevron
              onPress={() => router.push("/skills/market")}
            />
          </GroupSection>
        )}

        {/* 记忆进化批（能力门禁 memory——桌面被控面专属：画像查看/AI
            指令/开关/整理/重置） */}
        {capabilities?.includes("memory") && (
          <GroupSection>
            <ListItem
              icon={<Brain size={20} color={colors.primary} />}
              title={t("memory:title")}
              showChevron
              onPress={() => router.push("/memory")}
            />
          </GroupSection>
        )}

        {/* 备份面批（能力门禁 backup——桌面被控面专属：触发/列表/删除） */}
        {capabilities?.includes("backup") && (
          <GroupSection>
            <ListItem
              icon={<HardDriveUpload size={20} color={colors.primary} />}
              title={t("backup:title")}
              showChevron
              onPress={() => router.push("/backup")}
            />
          </GroupSection>
        )}

        {/* A2 专家管理（我的专家 + 专家市场，统一页内分段） */}
        {capabilities?.includes("chat") && (
          <GroupSection>
            <ListItem
              icon={<Users size={20} color={colors.primary} />}
              title={t("experts:title")}
              showChevron
              onPress={() => router.push("/experts")}
            />
          </GroupSection>
        )}

        {/* MCP 批连接器管理（能力门禁 mcp——桌面被控端专属；启停面，
            增删改引导桌面端） */}
        <McpSection />

        <GroupSection label={t("about")}>
          <View className="gap-2 rounded-lg border border-sep px-3 py-3 dark:border-[#545458A6]">
            <Text className="text-sm font-medium text-black dark:text-white">
              {t("appName")}
            </Text>
            <View className="flex-row items-center">
              <Text className="flex-1 text-sm text-label2 dark:text-[#EBEBF599]">
                {t("version")}
              </Text>
              <Text className="text-sm text-label2 dark:text-[#EBEBF599]">
                {appVersion}
              </Text>
              {/* 构建戳（真机排查「加载的是哪份代码」用）：metro 每次重编
                  该文件都会变化——重连后时间没变=没加载新代码 */}
              <Text className="text-xs text-label3 dark:text-[#EBEBF54D]">
                build 2026-10-21 19:12
              </Text>
            </View>
            <Text className="text-xs leading-4 text-label3 dark:text-[#EBEBF54D]">
              {t("knownLimitation")}
            </Text>
          </View>
        </GroupSection>
      </ScrollView>
    </SafeAreaView>
  );
}

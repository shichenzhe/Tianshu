import AsyncStorage from "@react-native-async-storage/async-storage";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import enUSChat from "./locales/en-US/chat.json";
import enUSCommon from "./locales/en-US/common.json";
import enUSConnections from "./locales/en-US/connections.json";
import enUSMemory from "./locales/en-US/memory.json";
import enUSBackup from "./locales/en-US/backup.json";
import enUSExperts from "./locales/en-US/experts.json";
import enUSLibrary from "./locales/en-US/library.json";
import enUSMcp from "./locales/en-US/mcp.json";
import enUSMonitor from "./locales/en-US/monitor.json";
import enUSNotify from "./locales/en-US/notify.json";
import enUSOrchestration from "./locales/en-US/orchestration.json";
import enUSPermission from "./locales/en-US/permission.json";
import enUSProviders from "./locales/en-US/providers.json";
import enUSProject from "./locales/en-US/project.json";
import enUSSettings from "./locales/en-US/settings.json";
import enUSSkills from "./locales/en-US/skills.json";
import enUSWorkspace from "./locales/en-US/workspace.json";
import zhCNChat from "./locales/zh-CN/chat.json";
import zhCNCommon from "./locales/zh-CN/common.json";
import zhCNConnections from "./locales/zh-CN/connections.json";
import zhCNMemory from "./locales/zh-CN/memory.json";
import zhCNBackup from "./locales/zh-CN/backup.json";
import zhCNExperts from "./locales/zh-CN/experts.json";
import zhCNLibrary from "./locales/zh-CN/library.json";
import zhCNMcp from "./locales/zh-CN/mcp.json";
import zhCNMonitor from "./locales/zh-CN/monitor.json";
import zhCNNotify from "./locales/zh-CN/notify.json";
import zhCNOrchestration from "./locales/zh-CN/orchestration.json";
import zhCNPermission from "./locales/zh-CN/permission.json";
import zhCNProviders from "./locales/zh-CN/providers.json";
import zhCNProject from "./locales/zh-CN/project.json";
import zhCNSettings from "./locales/zh-CN/settings.json";
import zhCNSkills from "./locales/zh-CN/skills.json";
import zhCNWorkspace from "./locales/zh-CN/workspace.json";

export const DEFAULT_LOCALE = "zh-CN";
export const LOCALE_KEY = "tianshu-mobile.locale";
/** 旧版持久化 key（M4 key 统一前）：仅作迁移源读取，不再写入 */
const LEGACY_LOCALE_KEY = "tianshu-mobile-locale";

/**
 * i18n 装配（T11 补 connections/chat namespace + 语言持久化；双语 key 齐平由 locales.test.ts 守护）。
 * native 侧无 suspense，必须 useSuspense: false；fallbackLng 对齐默认语言（缺 key 回落中文而非英文）。
 */
void i18n.use(initReactI18next).init({
  resources: {
    "zh-CN": {
      common: zhCNCommon,
      connections: zhCNConnections,
      chat: zhCNChat,
      settings: zhCNSettings,
      orchestration: zhCNOrchestration,
      permission: zhCNPermission,
      notify: zhCNNotify,
      monitor: zhCNMonitor,
      providers: zhCNProviders,
      library: zhCNLibrary,
      project: zhCNProject,
      experts: zhCNExperts,
      skills: zhCNSkills,
      mcp: zhCNMcp,
      workspace: zhCNWorkspace,
      memory: zhCNMemory,
      backup: zhCNBackup,
    },
    "en-US": {
      common: enUSCommon,
      connections: enUSConnections,
      chat: enUSChat,
      settings: enUSSettings,
      orchestration: enUSOrchestration,
      permission: enUSPermission,
      notify: enUSNotify,
      monitor: enUSMonitor,
      providers: enUSProviders,
      library: enUSLibrary,
      project: enUSProject,
      experts: enUSExperts,
      skills: enUSSkills,
      mcp: enUSMcp,
      workspace: enUSWorkspace,
      memory: enUSMemory,
      backup: enUSBackup,
    },
  },
  lng: DEFAULT_LOCALE,
  fallbackLng: "zh-CN",
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

// 语言持久化恢复（异步，首帧中文兜底；读失败静默保持默认语言）。
// M4 key 统一 tianshu-mobile.* 命名段：先读新 key，空/非法则回落旧 key
// （tianshu-mobile-locale）并迁入写新档——旧档不删（幂等，无回滚需求）
void AsyncStorage.getItem(LOCALE_KEY)
  .then(async (saved) => {
    let locale: string | null = saved;
    if (locale !== "en-US" && locale !== "zh-CN") {
      locale = await AsyncStorage.getItem(LEGACY_LOCALE_KEY).catch(() => null);
      if (locale === "en-US" || locale === "zh-CN") {
        void AsyncStorage.setItem(LOCALE_KEY, locale).catch(() => {
          /* 静默：迁移写失败下次启动再迁 */
        });
      } else {
        locale = null;
      }
    }
    if (locale === "en-US" || locale === "zh-CN") i18n.changeLanguage(locale);
  })
  .catch(() => {
    /* 静默：原生模块读取异常不阻断启动 */
  });

export function setLocale(locale: "zh-CN" | "en-US"): void {
  void i18n.changeLanguage(locale);
  void AsyncStorage.setItem(LOCALE_KEY, locale).catch(() => {
    /* 静默：持久化失败不影响本次切换 */
  });
}

export default i18n;

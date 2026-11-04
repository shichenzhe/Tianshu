/**
 * i18n 初始化配置
 */

import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { zhCN, enUS } from "date-fns/locale";

// zh-CN
import zhCommon from "./locales/zh-CN/common.json";
import zhLayout from "./locales/zh-CN/layout.json";
import zhUser from "./locales/zh-CN/user.json";
import zhAI from "./locales/zh-CN/ai.json";
import zhChat from "./locales/zh-CN/chat.json";
import zhSettings from "./locales/zh-CN/settings.json";
import zhProject from "./locales/zh-CN/project.json";
import zhSecurity from "./locales/zh-CN/security.json";
import zhNewTask from "./locales/zh-CN/newTask.json";

// en-US
import enCommon from "./locales/en-US/common.json";
import enLayout from "./locales/en-US/layout.json";
import enUser from "./locales/en-US/user.json";
import enAI from "./locales/en-US/ai.json";
import enChat from "./locales/en-US/chat.json";
import enSettings from "./locales/en-US/settings.json";
import enProject from "./locales/en-US/project.json";
import enSecurity from "./locales/en-US/security.json";
import enNewTask from "./locales/en-US/newTask.json";

const resources = {
  "zh-CN": {
    common: zhCommon,
    layout: zhLayout,
    user: zhUser,
    ai: zhAI,
    chat: zhChat,
    settings: zhSettings,
    project: zhProject,
    security: zhSecurity,
    newTask: zhNewTask,
  },
  "en-US": {
    common: enCommon,
    layout: enLayout,
    user: enUser,
    ai: enAI,
    chat: enChat,
    settings: enSettings,
    project: enProject,
    security: enSecurity,
    newTask: enNewTask,
  },
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: "zh-CN",
    defaultNS: "common",
    ns: [
      "common",
      "layout",
      "user",
      "ai",
      "chat",
      "settings",
      "project",
      "security",
      "newTask",
    ],
    interpolation: {
      escapeValue: false,
    },
    detection: {
      // 仅根据本地缓存判断；首次启动无缓存时回退到 fallbackLng（zh-CN），不跟随系统语言
      order: ["localStorage"],
      lookupLocalStorage: "tianshu-locale",
      caches: ["localStorage"],
    },
  });

/**
 * 初始化语言设置
 * 在应用启动时调用，设置 document.documentElement.lang
 */
export function initLocale() {
  document.documentElement.lang = i18n.language || "zh-CN";

  i18n.on("languageChanged", (lng) => {
    document.documentElement.lang = lng;
    localStorage.setItem("tianshu-locale", lng);
  });
}

/**
 * 获取 date-fns locale 对象
 */
export function getDateFnsLocale() {
  const currentLang = i18n.language || "zh-CN";
  if (currentLang === "en-US") {
    return { ...enUS, code: "en-US" };
  }
  return { ...zhCN, code: "zh-CN" };
}

export default i18n;

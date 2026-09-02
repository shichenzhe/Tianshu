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
import zhSystemConfig from "./locales/zh-CN/system-config.json";
import zhAI from "./locales/zh-CN/ai.json";
import zhWelcome from "./locales/zh-CN/welcome.json";

// en-US
import enCommon from "./locales/en-US/common.json";
import enLayout from "./locales/en-US/layout.json";
import enUser from "./locales/en-US/user.json";
import enSystemConfig from "./locales/en-US/system-config.json";
import enAI from "./locales/en-US/ai.json";
import enWelcome from "./locales/en-US/welcome.json";

const resources = {
  "zh-CN": {
    common: zhCommon,
    layout: zhLayout,
    user: zhUser,
    "system-config": zhSystemConfig,
    ai: zhAI,
    welcome: zhWelcome,
  },
  "en-US": {
    common: enCommon,
    layout: enLayout,
    user: enUser,
    "system-config": enSystemConfig,
    ai: enAI,
    welcome: enWelcome,
  },
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: "zh-CN",
    defaultNS: "common",
    ns: ["common", "layout", "user", "system-config", "ai", "welcome"],
    interpolation: {
      escapeValue: false,
    },
    detection: {
      // 仅根据本地缓存判断；首次启动无缓存时回退到 fallbackLng（zh-CN），不跟随系统语言
      order: ["localStorage"],
      lookupLocalStorage: "{{APP_NAME}}-locale",
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
    localStorage.setItem("{{APP_NAME}}-locale", lng);
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

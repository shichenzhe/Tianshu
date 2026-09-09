/**
 * 加载欢迎语（spec §5.3A）：streaming 持续超过 1.5s 后从文案池随机取一句，
 * 每 3s 轮换（不与上一句重复）；active=false 即时复位 null。
 * 开关关闭（welcomeLoading=false）由调用方不激活本 hook 实现。
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

const PHRASE_DELAY_MS = 1500;
const PHRASE_ROTATE_MS = 3000;

/** 随机取句并排除上一句（池仅一句时允许重复） */
export function pickPhrase(phrases: string[], exclude: string | null): string {
  const pool =
    phrases.length > 1 && exclude
      ? phrases.filter((phrase) => phrase !== exclude)
      : phrases;
  return pool[Math.floor(Math.random() * pool.length)] ?? "";
}

export function useLoadingPhrase(active: boolean): string | null {
  const { t } = useTranslation(["chat"]);
  const [phrase, setPhrase] = useState<string | null>(null);

  useEffect(() => {
    if (!active) {
      setPhrase(null);
      return;
    }
    const phrases = t("chat:loadingPhrases", {
      returnObjects: true,
    }) as string[];
    const rotate = () => setPhrase((prev) => pickPhrase(phrases, prev));
    const showTimer = window.setTimeout(rotate, PHRASE_DELAY_MS);
    const rotateTimer = window.setInterval(rotate, PHRASE_ROTATE_MS);
    return () => {
      window.clearTimeout(showTimer);
      window.clearInterval(rotateTimer);
    };
  }, [active, t]);

  return phrase;
}

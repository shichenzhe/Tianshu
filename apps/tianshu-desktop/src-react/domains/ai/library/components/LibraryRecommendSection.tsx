/**
 * 资料库「最近」底部推荐卡片区：第一排 2 列大卡（快速上手/资料库介绍）
 * + 第二排 4 列小卡（知识复利/人机协作/拖拽入库/三种载体）。纯展示
 * 引导区，不接跳转；文案全走 i18n，颜色全主题变量。
 */
import { useTranslation } from "react-i18next";
import { BookOpen, Rocket } from "lucide-react";

export default function LibraryRecommendSection() {
  const { t } = useTranslation(["chat"]);
  const features = [
    {
      icon: Rocket,
      title: t("chat:library.recommendQuickTitle"),
      desc: t("chat:library.recommendQuickDesc"),
    },
    {
      icon: BookOpen,
      title: t("chat:library.recommendIntroTitle"),
      desc: t("chat:library.recommendIntroDesc"),
    },
  ];
  const tips = ["tipKnowledge", "tipCollab", "tipDrag", "tipFormats"].map(
    (k) => ({
      title: t(`chat:library.${k}Title`),
      desc: t(`chat:library.${k}Desc`),
    }),
  );
  return (
    <section className="mt-6" data-testid="library-recommend">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {features.map((card) => (
          <div
            key={card.title}
            className="flex items-start gap-3 rounded-lg border border-border/50 bg-primary-subtle/30 p-5 transition-colors hover:border-primary/30 hover:bg-primary-subtle/60"
          >
            <card.icon className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
            <div className="min-w-0">
              <p className="text-base font-semibold text-foreground">
                {card.title}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">{card.desc}</p>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {tips.map((tip) => (
          <div
            key={tip.title}
            className="rounded-lg border border-border/50 bg-primary-subtle/30 p-4 transition-colors hover:border-primary/30 hover:bg-primary-subtle/60"
          >
            <p className="text-sm font-semibold text-foreground">{tip.title}</p>
            <p className="mt-1 text-xs text-muted-foreground">{tip.desc}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

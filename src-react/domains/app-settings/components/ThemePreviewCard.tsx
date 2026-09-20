/**
 * 主题预览大卡：按皮肤三元组局部作用域换肤——data-mode/data-theme/data-wallpaper
 * 写在卡片根元素，skins.css 属性选择器作用于卡片子树（CSS 变量继承），卡内模拟
 * 主界面构成：左窄侧栏条（主题相近背景色，不显示壁纸）+ 右侧对话区（壁纸集中
 * 在主面板，顶行小色条 / user 右气泡 / assistant 左气泡 / 底部输入条），全部
 * 消费主题语义变量，不硬编码颜色；
 * 右上角类型胶囊区分基础主题 / 精选皮肤
 */

import { useTranslation } from "react-i18next";

import type { SkinDef } from "@/domains/app-settings/model/skins";
import { getSkinName } from "./skin-name";

interface ThemePreviewCardProps {
  skin: SkinDef;
}

/** 左侧窄条（宽 1/5）：主题相近背景色（inline style 消费装饰变量，无壁纸时回落 bg-muted） */
function PreviewSidebar() {
  return (
    <div
      data-testid="preview-sidebar"
      className="w-1/5 shrink-0 border-r border-border/50 bg-muted"
      style={{ backgroundImage: "var(--skin-sidebar-bg, none)" }}
    />
  );
}

/** 右侧对话区（中间主面板）：顶行小色条 + user/assistant 气泡 + 底部输入条；
    壁纸叠层与 body 同款（overlay + image 两层），无壁纸时透出卡片根底色 */
function PreviewConversation() {
  return (
    <div
      data-testid="preview-conversation"
      className="flex flex-1 flex-col gap-2 p-3"
      style={{
        backgroundImage:
          "var(--skin-body-overlay, none), var(--skin-bg-image, none)",
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
    >
      <div className="h-2 w-8 rounded bg-primary" />
      <div className="flex justify-end">
        <div
          data-testid="preview-bubble-user"
          className="h-4 w-2/5 rounded-md bg-primary text-primary-foreground"
        />
      </div>
      <div className="flex justify-start">
        <div
          data-testid="preview-bubble-assistant"
          className="h-4 w-3/5 rounded-md bg-muted text-foreground"
        />
      </div>
      <div
        data-testid="preview-input-bar"
        className="mt-auto h-6 rounded-full border border-border/50"
      />
    </div>
  );
}

/** 右上角类型胶囊：深灰底白字，basic/premium 文案分流 */
function TypePill({ type }: { type: SkinDef["type"] }) {
  const { t } = useTranslation(["settings"]);

  return (
    <span
      data-testid="preview-type-pill"
      className="absolute right-2 top-2 z-10 rounded-full bg-foreground/80 px-2 py-0.5 text-xs font-medium text-background"
    >
      {t(
        type === "basic"
          ? "settings:appearance.basicType"
          : "settings:appearance.premiumType",
      )}
    </span>
  );
}

export default function ThemePreviewCard({ skin }: ThemePreviewCardProps) {
  const { t, i18n } = useTranslation(["settings"]);

  return (
    <div
      role="img"
      aria-label={`${t("settings:appearance.preview")} ${getSkinName(skin, i18n.language)}`}
      data-mode={skin.mode}
      data-theme={skin.hue}
      data-wallpaper={skin.wallpaper ?? undefined}
      className="relative flex h-64 overflow-hidden rounded-lg border border-border/50 bg-background shadow-sm"
    >
      <PreviewSidebar />
      <PreviewConversation />
      <TypePill type={skin.type} />
    </div>
  );
}

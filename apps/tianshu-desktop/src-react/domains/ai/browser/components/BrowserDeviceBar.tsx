/**
 * 设备模拟工具栏（菜单「显示设备工具栏」开关）：预设下拉 + 旋转 + 关闭。
 * 模拟活在 guest WebContents 上（enableDeviceEmulation，跨导航保留），
 * 卸载时关模拟（guest 已随 webview 销毁的场景静默——后端 guest 反查自拒）。
 * 面板 tab 常驻（display 隐藏不卸载），bar 与 guest 同生命周期不脱钩。
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { MonitorSmartphone, RotateCw, X } from "lucide-react";
import IconTooltip from "@/components/common/icon-tooltip";
import { invoke } from "@/lib/ipc";
import { mapIpcError } from "@/domains/ai/chat/lib/error-message";
import { readWebContentsId } from "../lib/webview-api";

interface DevicePreset {
  key: string;
  /** i18n key 后缀（chat:browser.<labelKey>） */
  labelKey: string;
  w: number;
  h: number;
  dpr: number;
  mobile: boolean;
}

const PRESETS: DevicePreset[] = [
  {
    key: "phone",
    labelKey: "devicePhone",
    w: 375,
    h: 667,
    dpr: 2,
    mobile: true,
  },
  {
    key: "phoneLarge",
    labelKey: "devicePhoneLarge",
    w: 412,
    h: 915,
    dpr: 3,
    mobile: true,
  },
  {
    key: "tablet",
    labelKey: "deviceTablet",
    w: 768,
    h: 1024,
    dpr: 2,
    mobile: true,
  },
  {
    key: "desktop",
    labelKey: "deviceDesktop",
    w: 1440,
    h: 900,
    dpr: 1,
    mobile: false,
  },
];

interface BrowserDeviceBarProps {
  getWebviewNode: () => HTMLElement | null;
  onClose: () => void;
}

export default function BrowserDeviceBar({
  getWebviewNode,
  onClose,
}: BrowserDeviceBarProps) {
  const { t } = useTranslation(["chat"]);
  const [presetKey, setPresetKey] = useState(PRESETS[0].key);
  const [landscape, setLandscape] = useState(false);
  const preset = PRESETS.find((p) => p.key === presetKey) ?? PRESETS[0];
  const size = landscape
    ? { w: preset.h, h: preset.w }
    : { w: preset.w, h: preset.h };
  // getNode 经 ref 转发：调用方传内联箭头（身份随渲染变），进 deps 会
  // 每渲染重放模拟（照 BrowserWebview onDomReadyRef 先例）
  const getNodeRef = useRef(getWebviewNode);
  useEffect(() => {
    getNodeRef.current = getWebviewNode;
  }, [getWebviewNode]);

  useEffect(() => {
    // 预设/方向变化即重放；卸载关模拟（失败静默——guest 可能已销毁）
    const node = getNodeRef.current();
    const wcId = readWebContentsId(node);
    if (wcId === null) {
      toast.error(t("chat:browser.pageNotReady"));
      return;
    }
    // 元素可视区随载荷上报：主进程按它自算 fit scale（Electron 44 无
    // scaleToFit，WebContents 亦无 getBounds 可查）
    const rect = node?.getBoundingClientRect();
    invoke("browser:emulateDevice", wcId, {
      width: size.w,
      height: size.h,
      deviceScaleFactor: preset.dpr,
      screenPosition: preset.mobile ? "mobile" : "desktop",
      ...(rect ? { availWidth: rect.width, availHeight: rect.height } : {}),
    }).catch((e) => toast.error(mapIpcError(e)));
    return () => {
      const id = readWebContentsId(getNodeRef.current());
      if (id !== null) {
        void invoke("browser:emulateDevice", id, null).catch(() => {});
      }
    };
  }, [presetKey, landscape, preset, size.w, size.h, t]);

  const btn =
    "rounded p-0.5 text-muted-foreground hover:bg-primary-subtle hover:text-primary";

  return (
    <div className="flex items-center gap-1.5 border-b border-border/50 px-2 py-1">
      <MonitorSmartphone className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <select
        value={presetKey}
        aria-label={t("chat:browser.deviceBarLabel")}
        onChange={(e) => setPresetKey(e.target.value)}
        className="h-6 rounded-md border border-border/50 bg-background px-1 text-xs outline-none focus:border-primary/30"
      >
        {PRESETS.map((p) => (
          <option key={p.key} value={p.key}>
            {t(`chat:browser.${p.labelKey}`)}
          </option>
        ))}
      </select>
      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
        {size.w}×{size.h}
      </span>
      <IconTooltip label={t("chat:browser.deviceRotate")}>
        <button
          type="button"
          className={btn}
          aria-label={t("chat:browser.deviceRotate")}
          onClick={() => setLandscape((v) => !v)}
        >
          <RotateCw className="h-3.5 w-3.5" />
        </button>
      </IconTooltip>
      <IconTooltip label={t("chat:browser.deviceClose")}>
        <button
          type="button"
          className={btn}
          aria-label={t("chat:browser.deviceClose")}
          onClick={onClose}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </IconTooltip>
    </div>
  );
}

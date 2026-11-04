/**
 * mermaid SVG → PNG 导出纯函数（jsdom 无 canvas，组件测试对 svgToPngDataUrl
 * mock；svgIntrinsicSize / fitExportScale 可直测）：
 * - 内禀尺寸取 viewBox（mermaid svg 带 width=100% 属性，naturalWidth 不可靠）
 * - 2x 采样保清晰度，超 canvas 上限（8192）自适应下调
 * - 按模式填底色：透明底深色主题导出贴浅色文档不可见
 */

/** PNG 导出默认采样倍率 */
export const PNG_EXPORT_SCALE = 2;
/** canvas 单边像素上限（Chrome 16384，留余量防宽高乘积超限） */
const CANVAS_EDGE_LIMIT = 8192;

/** svg 字符串内禀尺寸：viewBox 宽高，缺省/非法回退 800×600 */
export function svgIntrinsicSize(svg: string): {
  width: number;
  height: number;
} {
  const match =
    /viewBox="\s*([\d.eE+-]+)[\s,]+([\d.eE+-]+)[\s,]+([\d.eE+-]+)[\s,]+([\d.eE+-]+)/.exec(
      svg,
    );
  if (match) {
    const width = Number(match[3]);
    const height = Number(match[4]);
    if (Number.isFinite(width) && width > 0 && height > 0) {
      return { width, height };
    }
  }
  return { width: 800, height: 600 };
}

/** 采样倍率：默认 2x，任一边超上限按比例下调（取受限更严的一边） */
export function fitExportScale(width: number, height: number): number {
  const worst = Math.max(
    (width * PNG_EXPORT_SCALE) / CANVAS_EDGE_LIMIT,
    (height * PNG_EXPORT_SCALE) / CANVAS_EDGE_LIMIT,
  );
  return worst > 1 ? PNG_EXPORT_SCALE / worst : PNG_EXPORT_SCALE;
}

/** SVG 字符串 → PNG dataUrl；SVG 解码/画布不可用上抛（调用方 toast） */
export async function svgToPngDataUrl(
  svg: string,
  dark: boolean,
): Promise<string> {
  const { width, height } = svgIntrinsicSize(svg);
  const scale = fitExportScale(width, height);
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("MERMAID_PNG_RENDER_FAILED"));
      el.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("MERMAID_PNG_CANVAS_UNAVAILABLE");
    }
    ctx.scale(scale, scale);
    // 底色对齐当前模式背景（skins.css --color-background 同源色值）
    ctx.fillStyle = dark ? "#0f1115" : "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

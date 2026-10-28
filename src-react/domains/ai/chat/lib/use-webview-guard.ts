/**
 * webview 守卫 hook（抽取自 FileTabContent 内联守卫，T28 spec §16 项 6
 * 收敛至 chat/lib 共享——FileTabContent/LibraryTabBody/FilePreview/
 * LibraryPreviewContent 四消费方）：
 * will-navigate 全拦（初始 src 加载不经此事件）、did-fail-load 降级、
 * ERR_ABORTED（-3，切换预览时中止加载）不误降级、src 变更重绑复位。
 * React 合成事件不支持 webview 非标准事件，须原生监听（webview 条件
 * 渲染，src 就绪后重挂时重绑）。调用方 failed 语义：src 就绪但加载失败
 * 才置位（与 query 失败空态在调用方并列，本 hook 不吞并）。
 */
import { useEffect, useRef, useState } from "react";

export function useWebviewGuard(webviewSrc: string | null): {
  ref: React.RefObject<HTMLElement | null>;
  failed: boolean;
} {
  const [webviewFailed, setWebviewFailed] = useState(false);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    setWebviewFailed(false);
    const node = ref.current;
    if (!node) {
      return;
    }
    const onWillNavigate = (event: Event) => event.preventDefault();
    // ERR_ABORTED（-3，切换预览时中止加载）不误降级
    const onFail = (event: Event) => {
      if ((event as { errorCode?: number }).errorCode !== -3) {
        setWebviewFailed(true);
      }
    };
    node.addEventListener("will-navigate", onWillNavigate);
    node.addEventListener("did-fail-load", onFail);
    return () => {
      node.removeEventListener("will-navigate", onWillNavigate);
      node.removeEventListener("did-fail-load", onFail);
    };
  }, [webviewSrc]);
  return { ref, failed: webviewFailed };
}

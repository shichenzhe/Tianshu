/**
 * 页面顶行插槽（page-header slot）：各模块页面把原页内首行（标题/Tab/
 * 操作按钮）注册到此，TopBar 中段（PageHeaderHost）渲染，页面内容相应
 * 上移——顶栏右上角用户/语言按钮移入侧边栏后中段腾出（用户裁定）。
 */

import { useEffect, type ReactNode } from "react";
import { create } from "zustand";

export interface PageHeaderSlot {
  /** 标题左侧内容（返回按钮/侧栏收展开关等） */
  leading?: ReactNode;
  /** 标题文本或 Tab 组（可缺省——如会话视图顶行只有操作按钮） */
  title?: ReactNode;
  /** 右侧操作按钮区 */
  trailing?: ReactNode;
  /** 右段插槽（TopBar 产物面板段渲染）：右侧面板标题等迁入顶栏 */
  right?: ReactNode;
}

interface PageHeaderState {
  slot: PageHeaderSlot | null;
  setPageHeader: (slot: PageHeaderSlot | null) => void;
}

export const usePageHeaderStore = create<PageHeaderState>((set) => ({
  slot: null,
  setPageHeader: (slot) => set({ slot }),
}));

/**
 * 页面注册顶行：拆两个 effect——覆盖写（slot 每次渲染新引用的 ReactNode，
 * 无稳定依赖可用，每渲染覆盖一次）+ 仅卸载清空（防残留）。覆盖与清空
 * 分离消除了旧实现「重渲染时 cleanup 先回写 null 再覆盖」的双写抖动
 * （每次页面渲染 2 次 store 写、TopBar 空转一帧，见性能审查报告 M11）
 */
export function usePageHeader(slot: PageHeaderSlot | null) {
  const setPageHeader = usePageHeaderStore.getState().setPageHeader;
  useEffect(() => {
    setPageHeader(slot);
  }, [setPageHeader, slot]);
  useEffect(() => () => setPageHeader(null), [setPageHeader]);
}

/** 资料库预览 <webview> 标签（React 类型库不含；属性见 Electron docs） */
import type * as React from "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          src?: string;
          partition?: string;
          /** 存在性属性（Electron 按是否在 DOM 判定）；React 对非标准
           *  boolean 属性会丢弃，须写字符串字面量 "true" */
          allowpopups?: boolean | string;
          useragent?: string;
          webpreferences?: string;
        },
        HTMLElement
      >;
    }
  }
}

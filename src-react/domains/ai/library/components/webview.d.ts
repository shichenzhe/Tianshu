/** 资料库预览 <webview> 标签（React 类型库不含；属性见 Electron docs） */
import type * as React from "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          src?: string;
          partition?: string;
          allowpopups?: boolean;
          useragent?: string;
        },
        HTMLElement
      >;
    }
  }
}

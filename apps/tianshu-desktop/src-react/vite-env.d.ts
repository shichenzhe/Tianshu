/// <reference types="vite/client" />

/** 应用版本号（vite.config.ts define 编译期注入，源自 package.json） */
declare const __APP_VERSION__: string;

interface Window {
  platform: NodeJS.Platform;
  /** 拖拽文件路径（preload 经 webUtils.getPathForFile 暴露，File.path 的官方替代） */
  filePath: {
    getPathForFile(file: File): string;
  };
  ipcRenderer: {
    invoke(channel: string, ...args: unknown[]): Promise<unknown>;
    send(channel: string, ...args: unknown[]): void;
    on(
      channel: string,
      listener: (event: unknown, ...args: unknown[]) => void,
    ): () => void;
    once(
      channel: string,
      listener: (event: unknown, ...args: unknown[]) => void,
    ): void;
    removeAllListeners(channel: string): void;
  };
}

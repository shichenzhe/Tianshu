/// <reference types="vite/client" />

interface Window {
  platform: NodeJS.Platform;
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

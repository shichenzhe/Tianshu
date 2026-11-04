/**
 * 内置浏览器 guest 注册表（browser_use 工具组地基）：捕获
 * persist:browser-webview 的 guest WebContents（登记/URL 跟踪/销毁清理），
 * 并维护「会话 → 操控目标 guest」绑定（渲染层 dom-ready 上报，spec R19——
 * AI 仅操控绑定 tab）。纯逻辑：web-contents-created 事件源由薄壳
 * （Task 3 Application 装配）经 trackGuest 注入，vitest 零 electron。
 */
export interface GuestWebContentsLike {
  id: number;
  getURL(): string;
  isDestroyed(): boolean;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

interface RegistryEntry {
  contents: GuestWebContentsLike;
  url: string;
  sessionId: number | null;
}

export interface GuestEntry {
  id: number;
  url: string;
  sessionId: number | null;
}

export class GuestRegistry {
  private guests = new Map<number, RegistryEntry>();
  /** sessionId → guestId（bindSession 写；guest destroyed 清） */
  private sessionBinding = new Map<number, number>();

  trackGuest(contents: GuestWebContentsLike): void {
    const entry: RegistryEntry = {
      contents,
      url: contents.getURL(),
      sessionId: null,
    };
    this.guests.set(contents.id, entry);
    contents.on("did-navigate", (...args: unknown[]) => {
      const url = (args[0] as { url?: string } | undefined)?.url;
      if (typeof url === "string") entry.url = url;
    });
    contents.on("destroyed", () => {
      this.guests.delete(contents.id);
      for (const [sid, gid] of this.sessionBinding) {
        if (gid === contents.id) this.sessionBinding.delete(sid);
      }
    });
  }

  bindSession(sessionId: number, webContentsId: number): boolean {
    if (!this.guests.has(webContentsId)) return false;
    // 一个 guest 同一时刻只归属一个会话（改绑先清旧）
    for (const [sid, gid] of this.sessionBinding) {
      if (gid === webContentsId && sid !== sessionId) {
        this.sessionBinding.delete(sid);
      }
    }
    // 一个会话同一时刻只操控一个 guest：会话改指时旧 guest 的
    // entry.sessionId 残留清空（否则 list() 与实际绑定矛盾）
    const previousGid = this.sessionBinding.get(sessionId);
    if (previousGid !== undefined && previousGid !== webContentsId) {
      const previous = this.guests.get(previousGid);
      if (previous) previous.sessionId = null;
    }
    this.sessionBinding.set(sessionId, webContentsId);
    const entry = this.guests.get(webContentsId);
    if (entry) entry.sessionId = sessionId;
    return true;
  }

  forSession(sessionId: number): GuestEntry | null {
    const gid = this.sessionBinding.get(sessionId);
    if (gid === undefined) return null;
    const entry = this.guests.get(gid);
    if (!entry || entry.contents.isDestroyed()) {
      this.sessionBinding.delete(sessionId);
      this.guests.delete(gid);
      return null;
    }
    return { id: gid, url: entry.url, sessionId };
  }

  list(): GuestEntry[] {
    return [...this.guests.entries()].map(([id, e]) => ({
      id,
      url: e.url,
      sessionId: e.sessionId,
    }));
  }
}

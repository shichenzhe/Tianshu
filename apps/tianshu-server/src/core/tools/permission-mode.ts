/**
 * 会话级工具权限模式（自 mirror electron/domains/ai/agent/permission-mode.ts
 * 逐字移植）：default 每次写入询问，full 静默放行。纯内存态。
 */
export type AccessMode = 'default' | 'full';

export class PermissionStore {
  private modes = new Map<number, AccessMode>();

  /** 未设置的会话缺省 default（安全侧） */
  get(sessionId: number): AccessMode {
    return this.modes.get(sessionId) ?? 'default';
  }

  set(sessionId: number, mode: AccessMode): void {
    this.modes.set(sessionId, mode);
  }

  /** 当前 full 的会话 id 列表（插入序） */
  listFull(): number[] {
    return [...this.modes.entries()]
      .filter(([, mode]) => mode === 'full')
      .map(([sessionId]) => sessionId);
  }
}

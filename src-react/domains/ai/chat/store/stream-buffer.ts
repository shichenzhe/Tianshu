/**
 * 流式增量节流缓冲：30ms 内累积，超过间隔才向 React 吐一次
 */
export class StreamBuffer {
  private pending = "";
  private lastFlush = 0;

  constructor(private intervalMs = 30) {}

  push(delta: string, now = Date.now()): string | null {
    this.pending += delta;
    if (now - this.lastFlush >= this.intervalMs) {
      return this.flush(now);
    }
    return null;
  }

  flush(now = Date.now()): string {
    const out = this.pending;
    this.pending = "";
    this.lastFlush = now;
    return out;
  }
}

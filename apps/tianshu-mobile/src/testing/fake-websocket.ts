// 测试共用 RN WebSocket 替身（自 relay-transport-e2e.test.ts 收编单份）：
// 记录出站帧，允许测试注入服务端帧/生命周期事件——relay-transport 全链路
// 测试（e2e 状态机 / AK 连接前续期）共用同一替身语义。

/** RN WebSocket 替身：记录出站帧，允许测试注入服务端帧/生命周期事件 */
export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code?: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.onclose?.({ code: 1000 });
  }

  /** 测试辅助：服务端推帧 */
  push(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  frames(): unknown[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

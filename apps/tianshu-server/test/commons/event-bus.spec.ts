import { EventBusService } from 'src/commons/event-bus/event-bus.service';

describe('EventBusService', () => {
  it('publish 扇出到所有订阅者，退订后不再收到', () => {
    const bus = new EventBusService();
    const got: string[] = [];
    const off = bus.subscribe((e) => got.push(e.type));
    const off2 = bus.subscribe((e) => got.push(e.type + '2'));
    bus.publish({
      type: 'session.updated',
      payload: { id: 1, title: null, updatedAt: '2026-10-17T00:00:00.000Z', unreadCount: 0, lastMessage: null },
    });
    off2();
    bus.publish({
      type: 'session.updated',
      payload: { id: 2, title: null, updatedAt: '2026-10-17T00:00:01.000Z', unreadCount: 0, lastMessage: null },
    });
    expect(got).toEqual([
      'session.updated',
      'session.updated2',
      'session.updated',
    ]);
    // subscribe 契约：返回退订函数（off 声明保留自计划原值，此处消费以过 no-unused-vars）
    expect(typeof off).toBe('function');
  });

  it('publish 为同步扇出：publish 返回前订阅者已收到事件', () => {
    const bus = new EventBusService();
    const received: string[] = [];
    bus.subscribe((e) => received.push(e.type));
    bus.publish({
      type: 'session.error',
      payload: { sessionId: 1, code: 'E_TEST', message: 'sync check' },
    });
    // 同一调用栈内即可观察到，证明 EventEmitter 同步 emit 语义
    expect(received).toEqual(['session.error']);
  });
});

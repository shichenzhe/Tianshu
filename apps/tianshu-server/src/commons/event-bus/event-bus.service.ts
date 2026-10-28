import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { ServerEvent } from '@tianshu/protocol';

/** 协议事件订阅者函数 */
export type ServerEventHandler = (event: ServerEvent) => void;

/** 订阅者计数变化观察者函数（TB-T1：桥挂起请求的接收者消失收敛） */
export type SubscribersChangedHandler = () => void;

/** 事件在 EventEmitter 上的通道名（单通道，事件类型由 ServerEvent.type 判别） */
const SERVER_EVENT_CHANNEL = 'server-event';

/**
 * 协议事件总线
 *
 * Node EventEmitter 包装：publish 同步扇出给全部订阅者；
 * subscribe 返回退订函数。业务模块与 /event SSE 推送层借此解耦。
 */
@Injectable()
export class EventBusService implements OnModuleDestroy {
  private readonly emitter = new EventEmitter();
  /** 计数变化观察者（订阅/退订后同步通知——计数已落定，无 stale 读） */
  private readonly countWatchers = new Set<SubscribersChangedHandler>();

  constructor() {
    // 订阅者数量随 SSE 连接数增长，解除默认 10 监听器上限告警
    this.emitter.setMaxListeners(0);
  }

  /** 同步发布事件给所有订阅者 */
  publish(event: ServerEvent): void {
    this.emitter.emit(SERVER_EVENT_CHANNEL, event);
  }

  /** 订阅协议事件，返回退订函数 */
  subscribe(handler: ServerEventHandler): () => void {
    this.emitter.on(SERVER_EVENT_CHANNEL, handler);
    this.notifyCountChanged();
    return () => {
      this.emitter.off(SERVER_EVENT_CHANNEL, handler);
      this.notifyCountChanged();
    };
  }

  /**
   * 当前订阅者计数（SSE 连接 + relay 事件外推各占一席）。
   * TB-T1 桥工具的运行时可用性判据：0 = 无接收者（spec §2.3
   * 「桌面控制端不在线」）——桥调用立即拒的依据。
   */
  subscriberCount(): number {
    return this.emitter.listenerCount(SERVER_EVENT_CHANNEL);
  }

  /**
   * 订阅者计数变化通知（订阅/退订钩点后同步回调），返回退订函数。
   * TB-T1：bridge-registry 借此在最后一个接收者断开时立即收敛挂起请求
   * （spec §3 三路收敛的第三路），免等超时。
   */
  onSubscribersChanged(handler: SubscribersChangedHandler): () => void {
    this.countWatchers.add(handler);
    return () => this.countWatchers.delete(handler);
  }

  private notifyCountChanged(): void {
    for (const watcher of this.countWatchers) watcher();
  }

  onModuleDestroy(): void {
    this.emitter.removeAllListeners();
    this.countWatchers.clear();
  }
}

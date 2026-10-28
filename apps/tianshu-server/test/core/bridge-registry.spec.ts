// TB-T1：桌面工具桥挂起注册表（spec §3）——requestId → {resolve,timer}
// 挂起表的三路收敛（respond 到达/超时/接收者消失）+ 进程关闭全 abort。
// 覆盖（任务面）：
// 1. 挂起-respond 匹配：emit 经 EventBus 广播 tool.request（载荷四字段）、
//    respond 同 requestId 收敛、一次性（重复 respond false → 端点 4005）
// 2. 超时拒绝：timeoutMs 到点 ok:false（文案含超时）、挂起表清空、
//    超时后 respond 亦 false（收敛已被超时消费——requestId 一次性）
// 3. 未知 requestId respond false（端点 4005 的注册表层）
// 4. 零订阅者立即拒：无 SSE/relay 订阅者时 emit 不挂起直接
//    ok:false（文案含「桌面控制端不在线」——模型可见语义，spec §2.3）
// 5. 接收者清零立即拒（三路收敛第三路）：挂起中断开全部订阅者 →
//    pending 立即收敛 ok:false（不等超时）
// 6. 进程关闭全 abort：abortAllBridgeRequests 以指定理由收敛全部挂起
// 7. 运行时未安装的防御：emit 直接失败文案（graph 测试 app 未装
//    ToolModule 时不炸——registry 静态注册的桥工具可被误触）
// 4005 的 HTTP 面断言在 test/modules/tool-api.spec（端点 contract）。
import { EventBusService } from 'src/commons/event-bus/event-bus.service';
import type { BridgeToolResult, ToolRequestPayload } from '@tianshu/protocol';
import {
  emitToolRequest,
  respondBridgeTool,
  abortAllBridgeRequests,
  installBridgeRuntime,
  resetBridgeRuntime,
  pendingBridgeCount,
  type BridgeToolResult as BridgeToolResultReExport,
} from 'src/core/tools/bridge/bridge-registry';

/** 便于断言的已捕获 tool.request 事件 */
interface Captured {
  events: ToolRequestPayload[];
  offs: Array<() => void>;
}

/** 真实 EventBusService + 控制端订阅者模拟（SSE/relay 皆经 subscribe） */
function makeBus() {
  return new EventBusService();
}

/** 在 bus 上挂一个「控制端连接」并捕获 tool.request 广播 */
function fakeController(bus: EventBusService): Captured {
  const captured: Captured = { events: [], offs: [] };
  captured.offs.push(
    bus.subscribe((event) => {
      if (event.type === 'tool.request') captured.events.push(event.payload);
    }),
  );
  return captured;
}

/** 安装以真 bus 为出口的桥运行时（timeoutMs 可缩——超时用例快进） */
function install(bus: EventBusService, timeoutMs = 30_000) {
  installBridgeRuntime({
    publishToolRequest: (payload) =>
      bus.publish({ type: 'tool.request', payload }),
    subscriberCount: () => bus.subscriberCount(),
    timeoutMs: () => timeoutMs,
    onSubscribersChanged: (cb) => bus.onSubscribersChanged(cb),
  });
}

describe('bridge-registry（桌面工具桥挂起注册表）', () => {
  afterEach(() => {
    resetBridgeRuntime();
  });

  it('挂起-respond 匹配：广播 tool.request 载荷四字段、respond 收敛 output、一次性', async () => {
    const bus = makeBus();
    const controller = fakeController(bus);
    install(bus);

    const pending = emitToolRequest(7, 'browser_navigate', {
      url: 'https://example.com',
    });
    await Promise.resolve(); // publish 同步扇出，微任务拍平后即可见
    expect(pendingBridgeCount()).toBe(1);
    expect(controller.events).toHaveLength(1);
    const { requestId, ...rest } = controller.events[0];
    expect(typeof requestId).toBe('string');
    expect(requestId.length).toBeGreaterThan(0);
    expect(rest).toEqual({
      sessionId: 7,
      tool: 'browser_navigate',
      args: { url: 'https://example.com' },
    });

    // 未知 requestId 在收敛前也拒（一次性语义的另一面）
    expect(respondBridgeTool('no-such-id', { ok: true, output: 'x' })).toBe(
      false,
    );

    expect(
      respondBridgeTool(requestId, { ok: true, output: '已导航到页面' }),
    ).toBe(true);
    await expect(pending).resolves.toEqual({
      ok: true,
      output: '已导航到页面',
    });
    expect(pendingBridgeCount()).toBe(0);
    // 重复 respond：已收敛（端点面 → 4005）
    expect(respondBridgeTool(requestId, { ok: true, output: 'again' })).toBe(
      false,
    );
    controller.offs.forEach((off) => off());
  });

  it('失败结果透传：respond ok:false 的 error 原样收敛（控制端拒绝/执行失败回喂）', async () => {
    const bus = makeBus();
    const controller = fakeController(bus);
    install(bus);
    const pending = emitToolRequest(1, 'browser_click', { idx: 3 });
    await Promise.resolve();
    respondBridgeTool(controller.events[0].requestId, {
      ok: false,
      error: 'denied by user',
    });
    await expect(pending).resolves.toEqual({
      ok: false,
      error: 'denied by user',
    });
    controller.offs.forEach((off) => off());
  });

  it('超时拒绝：到点 ok:false 文案含超时、挂起表清空、迟到的 respond 亦 false', async () => {
    const bus = makeBus();
    const controller = fakeController(bus);
    install(bus, 30);
    const pending = emitToolRequest(2, 'browser_snapshot', {});
    await Promise.resolve();
    const requestId = controller.events[0].requestId;
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('超时');
    expect(pendingBridgeCount()).toBe(0);
    // 超时已消费该 requestId——迟到 respond 4005（防僵尸收敛）
    expect(respondBridgeTool(requestId, { ok: true, output: 'late' })).toBe(
      false,
    );
    controller.offs.forEach((off) => off());
  });

  it('零订阅者立即拒：无 SSE/relay 订阅者时不广播直接失败（文案含「桌面控制端不在线」）', async () => {
    const bus = makeBus();
    install(bus);
    const startedAt = Date.now();
    const result = await emitToolRequest(3, 'browser_snapshot', {});
    expect(Date.now() - startedAt).toBeLessThan(1000); // 立即——不等超时
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('桌面控制端不在线');
    expect(pendingBridgeCount()).toBe(0);
  });

  it('接收者清零立即拒（三路收敛第三路）：挂起中断开全部订阅者 → 不等超时即收敛', async () => {
    const bus = makeBus();
    const controller = fakeController(bus);
    install(bus, 60_000); // 长超时：证明收敛来自接收者消失而非定时器
    const pending = emitToolRequest(4, 'browser_type', {
      idx: 1,
      text: 'hi',
    });
    await Promise.resolve();
    expect(pendingBridgeCount()).toBe(1);
    controller.offs.forEach((off) => off());
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('桌面控制端不在线');
    expect(pendingBridgeCount()).toBe(0);
  });

  it('进程关闭全 abort：全部挂起以指定理由收敛（NestJS onModuleDestroy 出口）', async () => {
    const bus = makeBus();
    fakeController(bus);
    install(bus, 60_000);
    const first = emitToolRequest(5, 'browser_snapshot', {});
    const second = emitToolRequest(6, 'browser_click', { idx: 0 });
    await Promise.resolve();
    expect(pendingBridgeCount()).toBe(2);
    const aborted = abortAllBridgeRequests('服务进程关闭');
    expect(aborted).toBe(2);
    await expect(first).resolves.toEqual({
      ok: false,
      error: '服务进程关闭',
    });
    await expect(second).resolves.toEqual({
      ok: false,
      error: '服务进程关闭',
    });
    expect(pendingBridgeCount()).toBe(0);
  });

  it('运行时未安装的防御：emit 直接失败可读文案（不挂起不炸）', async () => {
    const result = await emitToolRequest(8, 'browser_snapshot', {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('未安装');
    expect(pendingBridgeCount()).toBe(0);
  });

  // TB-T3：BridgeToolResult 上提 @tianshu/protocol 单份——本仓 re-export
  // 与协议包类型同一（双向可赋值 witness；ts-jest 带类型检查，本地再定义
  // 双份即红——防退回双仓分叉）
  it('BridgeToolResult 类型同一性 witness（协议单份 vs 注册表 re-export）', () => {
    const fromProtocol: BridgeToolResult =
      null as unknown as BridgeToolResultReExport;
    const toProtocol: BridgeToolResultReExport =
      null as unknown as BridgeToolResult;
    expect([fromProtocol, toProtocol]).toHaveLength(2);
  });
});

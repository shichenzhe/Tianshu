/**
 * 桌面工具桥挂起注册表（TB-T1，spec §3）：requestId → {resolve, timer}。
 *
 * 无头端遇桥工具（browser 四件，定义在 browser-bridge-tools.ts）时执行体
 * 不本地执行——emitToolRequest 广播 tool.request（EventBus → SSE data 帧 /
 * relay event 帧既有链路）后挂起，等控制端桌面执行完经 POST tool/respond
 * 回传结果。收敛三路（spec §3）：
 * 1. respond 到达（requestId 一次性：重复/未知 respond 返回 false，
 *    端点层映射 4005——多控制端并发时首个生效，spec §7.1）；
 * 2. 超时（config tianshu.bridge.timeoutMs，缺省 30_000，含控制端审批等待）；
 * 3. 接收者消失（订阅者计数归零——「桌面控制端不在线」立即拒，免等超时）。
 * 进程关闭（NestJS onModuleDestroy，由 ToolModule 触发）全量 abort。
 *
 * 运行时句柄沿用 GA-T4 executor-runtime 先例：工具注册表为模块级静态
 * 装配（无 DI 缝），ToolModule 工厂经 installBridgeRuntime 注入 EventBus
 * 出口/订阅者计数/超时配置；未安装时 emit 直接以可读文案失败（graph
 * 测试 app 未装 ToolModule 时桥工具被误触不炸）。
 */
import { randomUUID } from 'node:crypto';
import type {
  BridgeToolResult,
  ServerEvent,
  ToolRequestPayload,
} from '@tianshu/protocol';

// 桥工具结果（respond 端点 result 的服务端收敛形态，spec §2.2）：
// TB-T3 上提 @tianshu/protocol 单份（ruling 4——双仓本地同形定义删本地
// 副本，mirror bridge-executor 同引）；re-export 保既有消费方
// （tool.controller）import 路径不动
export type { BridgeToolResult };

/** 零订阅者/接收者消失共用文案（模型可见语义，spec §2.3 逐字） */
export const BRIDGE_OFFLINE_ERROR =
  '桌面控制端不在线——桥工具需控制端桌面执行，请控制端连接后重试';

/** 运行时未安装的防御文案（graph 测试 app 等未装 ToolModule 场景） */
const RUNTIME_MISSING_ERROR =
  '桥运行时未安装（ToolModule 装配缺失）——本次桥调用无法送达控制端';

/** 桥运行时句柄（EventBus 出口 + 订阅者计数 + 超时配置） */
export interface BridgeRuntime {
  /** tool.request 广播出口（EventBusService.publish 包装） */
  publishToolRequest(payload: ToolRequestPayload): void;
  /** SSE/relay 订阅者计数（0 = 无接收者） */
  subscriberCount(): number;
  /** 桥调用超时毫秒（config tianshu.bridge.timeoutMs） */
  timeoutMs(): number;
  /** 订阅者计数变化通知（最后一个接收者断开时立即收敛挂起）；返回退订 */
  onSubscribersChanged(handler: () => void): () => void;
}

interface PendingEntry {
  settle: (result: BridgeToolResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingEntry>();

let installed: BridgeRuntime | undefined;
let offSubscribers: (() => void) | undefined;

/** 安装进程级运行时（ToolModule 工厂/测试装配；重复安装先拆旧） */
export function installBridgeRuntime(runtime: BridgeRuntime): void {
  resetBridgeRuntime();
  installed = runtime;
  offSubscribers = runtime.onSubscribersChanged(() => {
    if (runtime.subscriberCount() === 0) {
      abortAllBridgeRequests(BRIDGE_OFFLINE_ERROR);
    }
  });
}

/**
 * 撤销安装并收敛全部挂起（测试隔离/模块销毁出口）。
 * 退订计数观察须先于置空 installed（观察回调内不再访问半拆状态）。
 */
export function resetBridgeRuntime(): void {
  offSubscribers?.();
  offSubscribers = undefined;
  installed = undefined;
  abortAllBridgeRequests(RUNTIME_MISSING_ERROR);
}

/** 挂起数（观测/测试面） */
export function pendingBridgeCount(): number {
  return pending.size;
}

/**
 * 桥工具执行入口（browser-bridge-tools 执行体）：订阅者计数零立即拒
 * （spec §2.3），否则广播 tool.request 并挂起至三路收敛之一。
 */
export function emitToolRequest(
  sessionId: number | null,
  tool: ToolRequestPayload['tool'],
  args: Record<string, unknown>,
): Promise<BridgeToolResult> {
  const runtime = installed;
  if (!runtime) {
    return Promise.resolve({ ok: false, error: RUNTIME_MISSING_ERROR });
  }
  if (runtime.subscriberCount() === 0) {
    return Promise.resolve({ ok: false, error: BRIDGE_OFFLINE_ERROR });
  }
  const requestId = randomUUID();
  const promise = new Promise<BridgeToolResult>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve({
        ok: false,
        error: `桌面控制端应答超时（${runtime.timeoutMs()}ms）——审批等待计入超时，可在 config tianshu.bridge.timeoutMs 调大`,
      });
    }, runtime.timeoutMs());
    // 退出不等待：server 常驻进程由自身生命周期保活，此处不拽住进程
    timer.unref?.();
    pending.set(requestId, { settle: resolve, timer });
  });
  // 发布置于挂起登记后（respond 可能同步直达——先登记防竞速）
  runtime.publishToolRequest({ requestId, sessionId, tool, args });
  return promise;
}

/**
 * respond 收敛入口（POST tool/respond）：requestId 一次性——命中即消费
 * 返回 true；未知/已消费（重复、超时先收敛、接收者消失先收敛）返回
 * false，端点层映射 4005。
 */
export function respondBridgeTool(
  requestId: string,
  result: BridgeToolResult,
): boolean {
  const entry = pending.get(requestId);
  if (!entry) return false;
  pending.delete(requestId);
  clearTimeout(entry.timer);
  entry.settle(result);
  return true;
}

/** 全量 abort（进程关闭/测试隔离）：以指定理由收敛全部挂起，返回数量 */
export function abortAllBridgeRequests(reason: string): number {
  const count = pending.size;
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.settle({ ok: false, error: reason });
  }
  pending.clear();
  return count;
}

/** 组装 ServerEvent 的便捷出口（供测试/事件出口包装共用口径） */
export function toolRequestEvent(payload: ToolRequestPayload): ServerEvent {
  return { type: 'tool.request', payload };
}

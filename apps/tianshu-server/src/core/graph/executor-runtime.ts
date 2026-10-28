/**
 * graph-executor 无头化运行时装配点（GA-T4，授权面 1/2/5/7 的承载面）。
 *
 * mirror executor 的模块级副作用依赖（prisma 单例/Electron BrowserWindow/
 * Notification/monitor 埋点/commons/paths）在 server 侧收敛为本模块的
 * 进程级运行时句柄：graph 模块工厂（T6）与测试经 installGraphExecutorRuntime
 * 安装，executor 副本内经 graphExecutorRuntime() 取用——未安装时给出可读
 * 错误（防静默错库）。数据目录三件缺省自数据根派生（~/.tianshu-server，
 * TIANSHU_DATA_ROOT 优先——chat-runner resolveDataRoot 同源）。
 */
import { join } from 'node:path';
import type { PrismaService } from 'src/commons/database/prisma.service';
import { resolveDataRoot } from 'src/core/chat-runner.service';
import type { TraceEntry } from 'src/core/graph/graph-executor';
import type { GraphRunUpdatedPayload as GraphRunUpdatedWirePayload } from '@tianshu/protocol';

/**
 * graph.run.updated 事件载荷（GA-T6 起以协议包定义为 wire 契约单份——
 * 本文件原同构 interface 收编别名；字段语义注释见包内 server-event.ts）。
 */
export type GraphRunUpdatedPayload = GraphRunUpdatedWirePayload;

/**
 * run 状态投影（原 GraphRunState，GA-T4 review Minor 1 移交改名：与
 * @tianshu/core graph-compiler 的 LangGraph 状态接口 GraphRunState 同名
 * 不同义——graph-executor.ts 里同名引用是那个 LangGraph 状态，勿混）。
 * 值域 = GA-T4 投影枚举（Ruling 7 wire 契约）：queued 仅保留给控制层队列
 * 语义——server run 生命周期从 running 起（createRun 即落 running），
 * 不合成 queued；aborted 为 failed+user_aborted 的展示精化态（run 表单一
 * 状态源仍是 success|failed）。
 */
export type GraphRunProjectionState = GraphRunUpdatedPayload['state'];

/** 节点级状态（试运行画布高亮同源三态） */
export type GraphNodeRunStatus = NonNullable<
  GraphRunUpdatedPayload['progress']
>['nodeStatus'];

/** run 落库原语（graph.repository createRun/finishRun 的结构类型——
 * core 层不反向 import modules，实例结构兼容即可装配） */
export interface GraphRunStore {
  createRun: (p: {
    taskId: number | null;
    graphId: number;
    attempt: number;
    triggerType: string;
  }) => Promise<number>;
  finishRun: (p: {
    runId: number;
    status: 'success' | 'failed';
    graphTrace: string;
    error: string | null;
    durationMs: number;
    promptTokens?: number | null;
    completionTokens?: number | null;
  }) => Promise<void>;
}

/** 监控埋点入参（mirror recordGraphMonitorEvents 同形；server 无 monitor 域） */
export interface GraphMonitorEventsParams {
  graphId: number;
  userId: number | null;
  sessionId: number | null;
  trace: TraceEntry[];
}

/** executor 进程级运行时（db 与 run 落库原语必装；其余可选缺省 no-op/派生） */
export interface GraphExecutorRuntime {
  /** server 自有 Prisma 句柄（授权面 2） */
  db: PrismaService;
  /** run 落库原语（授权面 2；与 GA-T3 仓储一致） */
  runs: GraphRunStore;
  /** graph.run.updated 事件出口（授权面 7；未注入不发事件——纯落库模式） */
  publishRunUpdated?: (payload: GraphRunUpdatedPayload) => void;
  /** notify 节点副作用（授权面 1；无头端缺省无桌面通知通道） */
  notify?: (title: string, body?: string) => void;
  /** 监控埋点（授权面 5；监控非关键路径，未注入跳过） */
  recordMonitorEvents?: (params: GraphMonitorEventsParams) => void;
  /** 技能目录（缺省数据根 skills/） */
  skillsDir?: () => string;
  /** 资料库目录（缺省数据根 library/） */
  libraryDir?: () => string;
  /** 工作流产物目录（缺省数据根 workflow-assets/） */
  workflowAssetsDir?: () => string;
}

let installed: GraphExecutorRuntime | undefined;

/** 安装进程级运行时（graph 模块工厂/测试入口各装一次） */
export function installGraphExecutorRuntime(rt: GraphExecutorRuntime): void {
  installed = rt;
}

/** 撤销安装（测试隔离用） */
export function resetGraphExecutorRuntime(): void {
  installed = undefined;
}

/** 缺省数据根（chat-runner 同源：TIANSHU_DATA_ROOT > ~/.tianshu-server） */
function defaultDataRoot(): string {
  return resolveDataRoot('~/.tianshu-server');
}

/** 取运行时（目录三件未显式注入时以数据根派生补齐） */
export function graphExecutorRuntime(): Required<
  Omit<
    GraphExecutorRuntime,
    'publishRunUpdated' | 'notify' | 'recordMonitorEvents'
  >
> &
  GraphExecutorRuntime {
  if (!installed) {
    throw new Error(
      'graph-executor 运行时未安装：先 installGraphExecutorRuntime（graph 模块工厂/测试装配）',
    );
  }
  const root = defaultDataRoot();
  return {
    ...installed,
    skillsDir: installed.skillsDir ?? (() => join(root, 'skills')),
    libraryDir: installed.libraryDir ?? (() => join(root, 'library')),
    workflowAssetsDir:
      installed.workflowAssetsDir ?? (() => join(root, 'workflow-assets')),
  };
}

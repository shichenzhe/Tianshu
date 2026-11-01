/**
 * 编排图模块（GA-T6 装配）：CRUD/试运行端点 + GA-T4 executor 进程级运行时
 * 安装（db=PrismaService、run 原语=GA-T3 仓储、事件出口=EventBus
 * graph.run.updated——executor 投影零 cast 直发）。EventBusModule 为全局
 * 模块（EventBusService 直接注入）。automation 模块 import 本模块以保证
 * 运行时先于其 scheduler/runner 消费就位。
 */
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import path from 'node:path';
import { PrismaModule } from 'src/commons/database/prisma.module';
import { PrismaService } from 'src/commons/database/prisma.service';
import { EventBusService } from 'src/commons/event-bus/event-bus.service';
import { tianshuDataRoot } from 'src/commons/config/tianshu-data-root';
import { WebhookModule } from 'src/modules/webhook/webhook.module';
import { WebhookService } from 'src/modules/webhook/webhook.service';
import {
  installGraphExecutorRuntime,
  type GraphExecutorRuntime,
} from 'src/core/graph/executor-runtime';
// installGraphExecutorRuntime 返回 void（安装即副作用）——工厂装完回
// runtime 本体作 provider 值（token 无消费面，Nest 启动期实例化即安装）
import { GraphRepository } from './graph.repository';
import { recordGraphMonitorEvents } from '@tianshu/core';
import { GraphService } from './graph.service';
import { GraphController } from './graph.controller';
import {
  makeWorkflowTools,
  WORKFLOW_TOOL_NAMES,
} from 'src/core/tools/workflow-tools';
import {
  makeDisplayTools,
  DISPLAY_TOOL_NAMES,
} from 'src/core/tools/display-tools';
import { unregisterTools, registerTools } from 'src/core/tools/tool-registry';
import { installWorkflowTools } from 'src/core/tools/workflow-toolbox';

/** 运行时安装 provider token（无消费面——Nest 启动期实例化工厂即安装） */
export const GRAPH_EXECUTOR_RUNTIME = Symbol('GRAPH_EXECUTOR_RUNTIME');

/** registry 注册 provider token（无消费面——Nest 启动期实例化工厂即注册） */
export const GRAPH_TOOLS_REGISTRATION = Symbol('GRAPH_TOOLS_REGISTRATION');



@Module({
  // WebhookModule（GA-T7）：deleteGraph 钩子接线依赖 WebhookService + 触发
  // 链依赖本模块安装的 executor 运行时（共驻保证）
  imports: [PrismaModule, WebhookModule],
  controllers: [GraphController],
  providers: [
    // GA-T3 改造点 4 钩子接线（GA-T7）：deleteGraph 的 webhook 注册清理
    // no-op 缺省替换为真实实现（mirror graph.repo 动态 import
    // webhook-server 的无头端等价）
    {
      provide: GraphRepository,
      useFactory: (prisma: PrismaService, webhook: WebhookService) =>
        new GraphRepository(prisma, (graphId: number) =>
          webhook.unregisterWebhook(graphId),
        ),
      inject: [PrismaService, WebhookService],
    },
    {
      provide: GRAPH_EXECUTOR_RUNTIME,
      inject: [PrismaService, GraphRepository, EventBusService, ConfigService],
      useFactory: (
        prisma: PrismaService,
        repository: GraphRepository,
        bus: EventBusService,
        configService: ConfigService,
      ): GraphExecutorRuntime => {
        // 目录三件显式注入 config 数据根派生（chat/automation 同口径）——
        // 缺席时 executor-runtime 兜底只认 env（TIANSHU_DATA_ROOT >
        // ~/.tianshu-server），config.yml 调 dataRoot 会与 chat 分裂
        const dataRoot = tianshuDataRoot(configService);
        const runtime: GraphExecutorRuntime = {
          db: prisma,
          runs: repository,
          skillsDir: () => path.join(dataRoot, 'skills'),
          libraryDir: () => path.join(dataRoot, 'library'),
          workflowAssetsDir: () => path.join(dataRoot, 'workflow-assets'),
          // 授权面 2/7（GA-T4 头注释）：db/run 原语 + 事件出口注入化
          publishRunUpdated: (payload) =>
            bus.publish({ type: 'graph.run.updated', payload }),
          // 授权面 5（MO 批兑现）：trace 收尾 → 监控事件（fire-and-forget
          // 吞错在 core recordGraphMonitorEvents 内）
          recordMonitorEvents: (params) =>
            void recordGraphMonitorEvents(prisma, params),
        };
        installGraphExecutorRuntime(runtime);
        return runtime;
      },
    },
    GraphService,
    // F1/F2（2026-10-29）：工作流六件 + 展示三件注册进聚合 registry——
    // graph LLM 节点 tools:true 经 registry 获得（mirror 同构：六件在
    // mirror 由 GraphRepository 构造注册）；chat 会话另经
    // ChatRunnerService.collectToolDefinitions 按 mirror 场景门控取用。
    // subflow 节点与 run_workflow 非冗余：subflow 是设计期静态引用
    // （graphId 固定），run_workflow 是运行期动态选择（list→选→填参），
    // 图内 LLM 两者互补（结论备案）
    {
      provide: GRAPH_TOOLS_REGISTRATION,
      inject: [PrismaService, GraphService],
      useFactory: (prisma: PrismaService, graphService: GraphService) => {
        const toolbox = [
          ...makeWorkflowTools({
            prisma: prisma as never,
            runGraph: (dto) => graphService.run(dto),
          }),
          ...makeDisplayTools(),
        ];
        unregisterTools([...WORKFLOW_TOOL_NAMES, ...DISPLAY_TOOL_NAMES]);
        registerTools(toolbox);
        // chat 侧取用口（零依赖传递盒——不经 chat-runner import registry，
        // 避免补全既有静态环②致 library-tools 半初始化）
        installWorkflowTools(toolbox);
        return true;
      },
    },
  ],
  exports: [GraphRepository],
})
export class GraphModule {}

import { Module } from '@nestjs/common';
import { PrismaModule } from './commons/database/prisma.module';
import { ClsModule } from 'nestjs-cls';
import { UserModule } from './modules/user/user.module';
import { MonitorModule } from './modules/monitor/monitor.module';
import { AuthModule } from './commons/auth/auth.module';
import { AuthModule as AuthControllerModule } from './modules/auth/auth.module';
import { OptionService } from './modules/option/option.service';
import { APP_INTERCEPTOR, APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ResponseInterceptor } from './commons/web/interceptor/response.interceptor';
import { HttpExceptionFilter } from './commons/web/filter/http-exception.filter';
import { ConfigModule } from '@nestjs/config';
import configuration from './commons/config/configuration';
import { RequestLoggerInterceptor } from './commons/web/interceptor/request-logger.interceptor';
import { LogModule } from './commons/log/log.module';
import { v4 as uuidv4 } from 'uuid';
import { FastifyRequest } from 'fastify';
import { JsonSerializerInterceptor } from './commons/web/interceptor/json-serializer.interceptor';
import { OperationLogInterceptor } from './modules/operationlog/operation-log.interceptor';
import { HealthModule } from './commons/web/management/health/health.module';
import { MetricsModule } from './commons/web/management/metrics/metrics.module';
import { MetricsInterceptor } from './commons/web/management/metrics/metrics.interceptor';
import { OperationLogModule } from './modules/operationlog/operation-log.module';
import { EventBusModule } from './commons/event-bus/event-bus.module';
import { StaticTokenGuard } from './commons/auth/guard/token.guard';
import { EventModule } from './modules/event/event.module';
import { InfoModule } from './modules/info/info.module';
import { SessionModule } from './modules/session/session.module';
import { ProviderModule } from './modules/provider/provider.module';
import { AssistantModule } from './modules/assistant/assistant.module';
import { WorkspaceModule } from './modules/workspace/workspace.module';
import { SkillsModule } from './modules/skills/skills.module';
import { FilesModule } from './modules/files/files.module';
import { GraphModule } from './modules/graph/graph.module';
import { AutomationModule } from './modules/automation/automation.module';
import { WebhookModule } from './modules/webhook/webhook.module';
import { ToolModule } from './modules/tool/tool.module';
import { ChatCoreModule } from './core/chat-core.module';
import { PermissionModule } from './modules/permission/permission.module';
import { LibraryModule } from './modules/library/library.module';
import { BackupModule } from './modules/backup/backup.module';
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration], //加载配置文件
    }) as any,
    ClsModule.forRoot({
      middleware: {
        mount: true,
        generateId: true,
        idGenerator: (req: FastifyRequest) => {
          return (req.headers['trace_id'] as string) || uuidv4();
        },
      },
    }),
    LogModule,
    UserModule,
    AuthModule.forRoot({ global: true }),
    AuthControllerModule,
    HealthModule,
    MetricsModule.forRoot(),
    PrismaModule,
    OperationLogModule,
    EventBusModule,
    InfoModule,
    EventModule,
    SessionModule,
    ProviderModule,
    AssistantModule,
    WorkspaceModule,
    SkillsModule,
    FilesModule,
    GraphModule,
    AutomationModule,
    ChatCoreModule,
    // A10 审批记忆批：permission 五端点（remembered 表读删 + full 运行态）
    PermissionModule,
    // library 批（spec 2026-10-26）：资料库十七端点管理面（golden 移植
    // 磁盘原语——src/core/library/library-disk.repository.ts）
    LibraryModule,
    MonitorModule,
    // GA-T7：webhook 触发端点（GraphModule 亦 import 本模块——deleteGraph
    // 钩子接线 + executor 运行时共驻；此处显式装配自文档化）
    WebhookModule,
    // TB-T1：工具桥——respond 端点 + bridge 运行时装配（graph LLM 节点
    // 的桥工具消费该运行时，bootstrap 期统一就位）
    ToolModule,
    // 备份批（spec 2026-10-27）：桌面端全量数据备份六端点——
    // BackupGuard 二层专用 token（TIANSHU_BACKUP_TOKEN）
    BackupModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: StaticTokenGuard }, // 静态 token 守卫：TIANSHU_TOKEN 设置时全局校验 Bearer/query token，不感知 @Public；豁免 ${contextPath}/webhook/ 与 ${contextPath}/backup/ 两前缀（webhook=外部系统仅凭每图 token，终审 F1；backup=三层鉴权实况，终审 C1——JWT 层经 BackupController 类级 @Public 豁免 → 本守卫 backup 前缀豁免 → BackupGuard fail-closed 二层兜底）。
    { provide: APP_INTERCEPTOR, useClass: RequestLoggerInterceptor }, // 应用请求日志拦截器。
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor }, // 应用响应拦截器。
    { provide: APP_INTERCEPTOR, useClass: JsonSerializerInterceptor },
    { provide: APP_INTERCEPTOR, useClass: OperationLogInterceptor }, // 应用操作日志拦截器。
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor }, // 应用性能指标拦截器。
    { provide: APP_FILTER, useClass: HttpExceptionFilter }, // 应用异常响应过滤器。
    OptionService,
  ],
})
export class AppModule {}

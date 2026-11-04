/**
 * 无头 chat 核心模块：注册 ChatRunnerService（T7 send 端点消费）。
 * config.yml tianshu 段 → ChatRunnerDeps.config 工厂装配（dataRoot 经
 * TIANSHU_DATA_ROOT 环境变量可覆盖，与桌面端测试隔离约定同构）。
 * 安全门装配（2026-11-01 审查批 P0）：installCommandGate/installFileGate
 * 此前全仓无调用方——命令/文件黑名单（已自 mirror 逐字移植）运行时全部
 * fail-open；本模块 onModuleInit 以 config tianshu.security 段装配两门
 * （缺省 sandboxEnabled=true，内置敏感路径保护即生效），闭包实时读配置。
 * HTTP 节点守卫策略（逃生口 2026-11-04）同宿主装配：tianshu.graph 段
 * → installGraphHttpUrlPolicy（缺省严拦，见 graph-executor seam 注释）。
 */
import { Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { join } from 'node:path';
import { PrismaModule } from 'src/commons/database/prisma.module';
import type { TianshuConfig } from 'src/commons/config/tianshu-config.entity';
import { TianshuConfig as TianshuConfigEntity } from 'src/commons/config/tianshu-config.entity';
import { installGraphHttpUrlPolicy } from 'src/core/graph/graph-executor';
import {
  ChatRunnerService,
  CHAT_RUNNER_DEPS,
  resolveDataRoot,
} from './chat-runner.service';
import {
  installCommandGate,
  makeCommandDecider,
} from 'src/core/security/command-gate';
import { installFileGate, makeFileDecider } from 'src/core/security/file-gate';

/** 两门装配器（OnModuleInit 宿主；导出装配函数供单测直调） */
export function installSecurityGates(configService: ConfigService): void {
  const tianshuOf = () =>
    configService.get<TianshuConfig>(
      'tianshu',
      TianshuConfigEntity.getDefault(),
    );
  installCommandGate(
    makeCommandDecider(() => {
      const security = tianshuOf().security ?? TianshuSecurityDefault;
      return {
        sandboxEnabled: security.sandboxEnabled,
        programBlacklist: security.programBlacklist,
        cmdAsk: security.cmdAsk,
        cmdAllow: security.cmdAllow,
      };
    }),
  );
  installFileGate(
    makeFileDecider(
      () => {
        const security = tianshuOf().security ?? TianshuSecurityDefault;
        return {
          sandboxEnabled: security.sandboxEnabled,
          fileBlocklist: security.fileBlocklist,
          fileAllowlist: security.fileAllowlist,
        };
      },
      // extraBuiltin：数据根自我保护（启动读一次；mirror 同款语义）
      [resolveDataRoot(tianshuOf().dataRoot)],
    ),
  );
}

const TianshuSecurityDefault = TianshuConfigEntity.getDefault().security!;

/**
 * 图编排 HTTP 节点守卫策略装配（逃生口 2026-11-04）：config.yml
 * tianshu.graph 段闭包实时读——缺省严拦（allowPrivateNetwork=false +
 * 空 allowlist），部署方显式登记才放行（协议/metadata/链路本地硬边界
 * 不随策略，见 core graph-http-guard 头注释）
 */
export function installGraphHttpGuardPolicy(
  configService: ConfigService,
): void {
  const graphDefault = TianshuConfigEntity.getDefault().graph!;
  installGraphHttpUrlPolicy(() => {
    const graph =
      configService.get<TianshuConfig>(
        'tianshu',
        TianshuConfigEntity.getDefault(),
      ).graph ?? graphDefault;
    return {
      allowPrivateNetwork: graph.allowPrivateNetwork,
      allowlist: graph.allowlist,
    };
  });
}

@Injectable()
class SecurityGateInstaller implements OnModuleInit {
  constructor(private readonly configService: ConfigService) {}
  onModuleInit(): void {
    installSecurityGates(this.configService);
    installGraphHttpGuardPolicy(this.configService);
  }
}

@Module({
  imports: [PrismaModule],
  providers: [
    {
      provide: CHAT_RUNNER_DEPS,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        config: () => {
          const tianshu = configService.get<TianshuConfig>(
            'tianshu',
            TianshuConfigEntity.getDefault(),
          );
          return {
            dataRoot: resolveDataRoot(tianshu.dataRoot),
            allowDangerousTools: tianshu.chat?.allowDangerousTools ?? false,
            // T6 复审 M3 / T7 审批裁定：删除保护与审批模式自 config 注入
            deleteProtection: tianshu.chat?.deleteProtection ?? true,
            accessMode: tianshu.chat?.accessMode ?? 'default',
            // manual 模式审批挂起上限（缺省 5 分钟，agent 装配处兜底同值）
            approvalTimeoutMs: tianshu.chat?.approvalTimeoutMs ?? 300_000,
          };
        },
      }),
    },
    SecurityGateInstaller,
    ChatRunnerService,
  ],
  exports: [ChatRunnerService],
})
export class ChatCoreModule {}

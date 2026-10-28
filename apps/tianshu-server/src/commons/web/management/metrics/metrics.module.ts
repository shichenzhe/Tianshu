import { Module, DynamicModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MetricsService } from './metrics.service';
import { MetricsController } from './metrics.controller';
import { ActuatorGuard } from './actuator.guard';
import { LogModule } from '../../../log/log.module';
import configuration from '../../../config/configuration';

/**
 * Metrics模块选项接口
 */
export interface MetricsModuleOptions {
  /**
   * 是否注册为全局模块
   * @default false
   */
  global?: boolean;
}

/**
 * Metrics模块
 * 提供性能指标采集和暴露功能
 * 支持Prometheus格式的指标输出
 */
@Module({})
export class MetricsModule {
  /**
   * 注册Metrics模块
   * @param options 模块配置选项
   * @returns 动态模块
   */
  static register(options: MetricsModuleOptions = {}): DynamicModule {
    return {
      module: MetricsModule,
      global: options.global || false,
      imports: [
        ConfigModule.forRoot({
          isGlobal: false,
          load: [configuration], // 加载配置文件
        }),
        LogModule, // 依赖日志模块
      ],
      controllers: [MetricsController],
      providers: [MetricsService, ActuatorGuard],
      exports: [MetricsService], // 导出服务供其他模块使用
    };
  }

  /**
   * 注册为全局模块
   * @returns 全局动态模块
   */
  static forRoot(): DynamicModule {
    return this.register({ global: true });
  }
}

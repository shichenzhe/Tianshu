import { Controller, Get } from '@nestjs/common';

/**
 * 受保护探针路由（Task 9 bootstrap 验收临时占位）：
 * 鉴权由 AppModule 的全局 APP_GUARD（JwtAuthGuard）承担——本控制器
 * 无 @Public 即默认受保护。
 *
 * TODO(T10)：users 列表等真实管理路由上线后删除本探针。
 */
@Controller('relay-admin')
export class RaProbeController {
  @Get('__probe')
  probe(): { ok: boolean } {
    return { ok: true };
  }
}

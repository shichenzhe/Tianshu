import { applyDecorators, UseGuards, SetMetadata } from '@nestjs/common';
import { BasicAuthGuard } from '../guard/basic-auth.guard';

// 定义Basic Auth元数据键
export const AUTH_KEY_BASIC = 'isBasicAuth';

/**
 * Basic Auth装饰器
 * 标记路由使用Basic认证，覆盖全局JWT认证
 */
export function BasicAuth() {
  return applyDecorators(
    SetMetadata(AUTH_KEY_BASIC, true),
    UseGuards(BasicAuthGuard),
  );
}

import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard as PassportAuthGuard } from '@nestjs/passport';
import { Observable } from 'rxjs';
import { IS_PUBLIC_KEY } from '../decorator/public.decorator';
import { AUTH_KEY_JWT } from '../decorator/jwt-auth.decorator';
import { OperateContext } from 'src/commons/entity/operate-context.entity';

/**
 * basic auth认证守卫
 */
@Injectable()
export class BasicAuthGuard
  extends PassportAuthGuard('basic')
  implements CanActivate
{
  constructor(private reflector: Reflector) {
    super();
  }

  canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    // 是否是公共路由
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    // 检查是否标记为使用Basic Auth
    const isJwtAuth = this.reflector.getAllAndOverride<boolean>(AUTH_KEY_JWT, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isJwtAuth) return true;
    // 校验token
    return super.canActivate(context);
  }

  /**
   * 获取认证策略
   * @param context 执行上下文
   * @returns 认证策略数组
   */
  getAuthenticateOptions() {
    return {
      session: false, //session: false 表示不使用会话认证，这是现代API的常见做法
      property: 'operateContext', //property: "user" 指定将认证后的用户信息存储在 request.operateContext 属性中
    };
  }

  /**
   * 处理认证请求
   * @param err 错误信息
   * @param user 用户信息
   * @param info 附加信息
   * @param context 执行上下文
   * @returns 用户信息
   */
  handleRequest(err: any, user: any): any {
    // 如果有错误或用户不存在，抛出未授权异常
    if (err || !user) {
      throw err || new UnauthorizedException('认证失败');
    }

    return new OperateContext(user);
  }
}

import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredRoles) {
      return true;
    }

    const { operateContext } = context.switchToHttp().getRequest();
    if (!operateContext) {
      throw new ForbiddenException('用户信息缺失');
    }

    // const hasRole = requiredRoles.some((role) =>
    //   operateContext.roles?.includes(role),
    // );
    // if (!hasRole) {
    //   throw new ForbiddenException('权限不足');
    // }

    return true;
  }
}

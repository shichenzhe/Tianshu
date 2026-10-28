import { createParamDecorator } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { OperateContext } from 'src/commons/entity/operate-context.entity';

// 定义请求对象接口
interface RequestWithAccessContext extends Request {
  operateContext?: OperateContext;
}

export const AccessContext = createParamDecorator(
  (data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<RequestWithAccessContext>();
    return request.operateContext;
  },
);

/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-return */
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { map, Observable } from 'rxjs';
import { DateUtil } from 'src/commons/util/date.util';

@Injectable()
export class JsonSerializerInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(map((data) => this.serializeObject(data)));
  }

  private serializeObject<T>(obj: T): T {
    if (obj === null || obj === undefined) {
      return obj;
    }

    if (obj instanceof Date) {
      return DateUtil.format(obj) as T;
    }

    if (obj instanceof Decimal) {
      return obj.toNumber() as T;
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => this.serializeObject(item)) as T;
    }

    if (typeof obj === 'object') {
      const result = {} as Record<string, any>;
      Object.keys(obj).forEach((key) => {
        const value = (obj as Record<string, any>)[key];
        result[key] = this.serializeObject(value);
      });
      return result as T;
    }

    return obj;
  }
}

import {
  UnauthorizedException,
  ForbiddenException,
  NotFoundException,
  MethodNotAllowedException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ErrorCodeEnum } from './error-code.enum';
import { BusinessException } from './bussiness-exception';

export class ErrorCodeFactory {
  private static SimpleExceptionErrorCodeMap = new Map<
    new (...args: any[]) => Error,
    ErrorCodeEnum
  >([
    [UnauthorizedException, ErrorCodeEnum.UNAUTHORIZED],
    [ForbiddenException, ErrorCodeEnum.FORBIDDEN],
    [NotFoundException, ErrorCodeEnum.NOT_FOUND],
    [MethodNotAllowedException, ErrorCodeEnum.METHOD_NOT_ALLOWED],
    [UnsupportedMediaTypeException, ErrorCodeEnum.UNSUPPORTED_MEDIA_TYPE],
  ]);

  static get(exception: Error): ErrorCodeEnum {
    // 查找精确匹配的异常类型
    for (const [ExceptionType, errorCode] of this.SimpleExceptionErrorCodeMap) {
      if (exception instanceof ExceptionType) {
        return errorCode;
      }
    }

    if (exception instanceof BusinessException) {
      return exception.getCode() as ErrorCodeEnum;
    }

    // 默认返回内部服务器错误
    return ErrorCodeEnum.INTERNAL_SERVER_ERROR;
  }
}

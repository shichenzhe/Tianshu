import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCodeEnum } from './error-code.enum';

export class BusinessException extends HttpException {
  static DEFAULT_CODE = ErrorCodeEnum.INTERNAL_SERVER_ERROR;

  code: string;

  constructor(message: string, code: string) {
    super(message, HttpStatus.INTERNAL_SERVER_ERROR);
    this.code = code;
  }

  getCode(): string {
    return this.code;
  }

  // 实现：使用默认参数处理两种情况
  static of(
    message: string,
    code: string = BusinessException.DEFAULT_CODE,
  ): BusinessException {
    return new BusinessException(message, code);
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
    };
  }
}

import { Transform, TransformFnParams } from 'class-transformer';
import { DateUtil } from '../util/date.util';

/**
 * JSON日期时间转换装饰器
 * 支持多种日期格式的字符串转Date对象
 */
export function JsonDateTime() {
  return Transform((params: TransformFnParams): Date | null | undefined => {
    // 类型守卫检查
    if (!params || params.value === undefined || params.value === null) {
      return params.value;
    }
    // 如果已经是Date对象，校验有效性后直接返回
    if (params.value instanceof Date) {
      return DateUtil.isInvalidDate(params.value) ? null : params.value;
    }

    // 处理字符串类型
    if (typeof params.value === 'string') {
      return DateUtil.parseDate(params.value);
    }

    // 处理数字类型（时间戳）
    if (typeof params.value === 'number') {
      const date = new Date(params.value);
      if (isNaN(date.getTime())) {
        throw new Error(`Invalid timestamp: ${params.value}`);
      }
      return date;
    }

    throw new Error(`Unsupported date value type: ${typeof params.value}`);
  });
}

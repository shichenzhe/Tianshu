export class DateUtil {
  /**
   * 支持的日期格式模式
   */
  static DATE_PATTERNS = [
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, // yyyy-MM-dd'T'HH:mm:ss
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, // yyyy-MM-dd'T'HH:mm:ss'Z'
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{4}$/, // yyyy-MM-dd'T'HH:mm:ss.SSSZ
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, // yyyy-MM-dd HH:mm:ss
    /^\d{4}-\d{2}-\d{2}$/, // yyyy-MM-dd
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/, // yyyy-MM-dd HH:mm:ss.SSS
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{4}$/, // yyyy-MM-dd HH:mm:ss.SSSZ
  ];

  /**
   * 判断日期是否无效
   * @param date 待判断的日期
   * @returns true表示无效，false表示有效
   */
  static isInvalidDate(date: Date): boolean {
    if (!date) {
      return true;
    }
    return isNaN(date.getTime());
  }
  /**
   * 解析日期字符串
   * @param dateString 日期字符串
   * @returns 解析后的Date对象
   */
  static parseDate(dateString: string, datePatterns?: RegExp[]): Date | null {
    if (!dateString) {
      return null;
    }

    if (!datePatterns) {
      datePatterns = this.DATE_PATTERNS;
    }
    // 验证原始日期格式
    const isValidFormat = datePatterns.some((pattern) =>
      pattern.test(dateString),
    );
    if (!isValidFormat) {
      throw new Error(`Unsupported date format: ${dateString}`);
    }

    // 处理Z后缀，将Z替换为+0000（参考Java逻辑）
    const normalizedDateString = dateString.replace(/Z$/, '+0000');

    // 尝试解析日期
    const parsedDate = new Date(normalizedDateString);

    // 检查日期是否有效
    if (isNaN(parsedDate.getTime())) {
      throw new Error(`Invalid date value: ${dateString}`);
    }

    return parsedDate;
  }

  /**
   * 格式化日期，入参有待格式化日期，格式化样式（可选，默认为yyyy-MM-dd HH:mm:ss）
   * @param date 待格式化日期
   * @param format 格式化样式
   * @returns 格式化后的日期字符串
   */
  static format(date: Date, format?: string): string {
    if (!date) {
      return '';
    }

    if (!format) {
      return date.toLocaleString('sv-SE');
    }

    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const hours = date.getHours();
    const minutes = date.getMinutes();
    const seconds = date.getSeconds();
    const milliseconds = date.getMilliseconds();
    return format
      .replace('yyyy', year.toString())
      .replace('MM', month.toString().padStart(2, '0'))
      .replace('dd', day.toString().padStart(2, '0'))
      .replace('HH', hours.toString().padStart(2, '0'))
      .replace('mm', minutes.toString().padStart(2, '0'))
      .replace('ss', seconds.toString().padStart(2, '0'))
      .replace('SSS', milliseconds.toString().padStart(3, '0'));
  }

  /**
   * 截断日期，将时间部分设置为00:00:00.000
   * @param date 待截断日期
   * @returns 截断后的日期
   */
  static truncateDate(date: Date): Date {
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    return startOfDay;
  }

  /**
   * 截断日期，将时间部分设置为23:59:59.999
   * @param date 待截断日期
   * @returns 截断后的日期
   */
  static truncateDateToEndTime(date: Date): Date {
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);
    return endOfDay;
  }

  /**
   * 获取今日开始时间
   * @returns 今日开始时间
   */
  static getTodayStartTime(): Date {
    return this.truncateDate(new Date());
  }

  /**
   * 获取今日结束时间
   * @returns 今日结束时间
   */
  static getTodayEndTime(): Date {
    return this.truncateDateToEndTime(new Date());
  }

  /**
   * 获取本周开始时间，周一起算
   * @returns 本周开始时间
   */
  static getWeekStartTime(): Date {
    const today = new Date();
    const dayOfWeek = today.getDay(); // 0 (Sunday) to 6 (Saturday)
    const startOfWeek = new Date(today);
    startOfWeek.setDate(
      today.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1),
    ); // 周一为开始
    startOfWeek.setHours(0, 0, 0, 0);
    return startOfWeek;
  }

  /**
   * 获取本周结束时间
   * @returns 本周结束时间
   */
  static getWeekEndTime(): Date {
    const startOfWeek = this.getWeekStartTime();
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 6);
    endOfWeek.setHours(23, 59, 59, 999);
    return endOfWeek;
  }

  /**
   * 获取本月开始时间
   * @returns 本月开始时间
   */
  static getMonthStartTime(): Date {
    const today = new Date();
    const startOfMonth = new Date(today);
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    return startOfMonth;
  }

  /**
   * 获取本月结束时间
   * @returns 本月结束时间
   */
  static getMonthEndTime(): Date {
    const today = new Date();
    const endOfMonth = new Date(today);
    endOfMonth.setMonth(today.getMonth() + 1);
    endOfMonth.setDate(0);
    endOfMonth.setHours(23, 59, 59, 999);
    return endOfMonth;
  }

  /**
   * 获取本年开始时间
   * @returns 本年开始时间
   */
  static getYearStartTime(): Date {
    const today = new Date();
    const startOfYear = new Date(today);
    startOfYear.setMonth(0, 1);
    startOfYear.setHours(0, 0, 0, 0);
    return startOfYear;
  }

  /**
   * 获取本年结束时间
   * @returns 本年结束时间
   */
  static getYearEndTime(): Date {
    const today = new Date();
    const endOfYear = new Date(today);
    endOfYear.setMonth(11, 31);
    endOfYear.setHours(23, 59, 59, 999);
    return endOfYear;
  }
}

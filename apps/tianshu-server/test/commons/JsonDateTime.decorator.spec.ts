import { plainToInstance } from 'class-transformer';
import { JsonDateTime } from '../../src/commons/codec/JsonDateTime.decorator';

// 测试用的DTO类
class TestDto {
  @JsonDateTime()
  dateField: Date;

  @JsonDateTime()
  optionalDateField?: Date;

  @JsonDateTime()
  nullableDateField: Date | null;
}

describe('JsonDateTime Decorator', () => {
  describe('字符串日期解析', () => {
    it("should parse ISO datetime string (yyyy-MM-dd'T'HH:mm:ss)", () => {
      // Arrange
      const input = { dateField: '2023-12-25T10:30:45' };

      // Act
      const result = plainToInstance(TestDto, input);

      // Assert
      expect(result.dateField).toBeInstanceOf(Date);
      expect(result.dateField.getFullYear()).toBe(2023);
      expect(result.dateField.getMonth()).toBe(11); // 月份从0开始
      expect(result.dateField.getDate()).toBe(25);
      expect(result.dateField.getHours()).toBe(10);
      expect(result.dateField.getMinutes()).toBe(30);
      expect(result.dateField.getSeconds()).toBe(45);
    });

    it("should parse ISO datetime with timezone (yyyy-MM-dd'T'HH:mm:ss.SSSZ)", () => {
      // Arrange
      const input = { dateField: '2023-12-25T10:30:45.123+0800' };

      // Act
      const result = plainToInstance(TestDto, input);

      // Assert
      expect(result.dateField).toBeInstanceOf(Date);
      expect(result.dateField.getFullYear()).toBe(2023);
    });

    it('should parse datetime with space separator (yyyy-MM-dd HH:mm:ss)', () => {
      // Arrange
      const input = { dateField: '2023-12-25 10:30:45' };

      // Act
      const result = plainToInstance(TestDto, input);

      // Assert
      expect(result.dateField).toBeInstanceOf(Date);
      expect(result.dateField.getFullYear()).toBe(2023);
      expect(result.dateField.getMonth()).toBe(11);
      expect(result.dateField.getDate()).toBe(25);
    });

    it('should parse date only (yyyy-MM-dd)', () => {
      // Arrange
      const input = { dateField: '2023-12-25' };

      // Act
      const result = plainToInstance(TestDto, input);

      // Assert
      expect(result.dateField).toBeInstanceOf(Date);
      expect(result.dateField.getFullYear()).toBe(2023);
      expect(result.dateField.getMonth()).toBe(11);
      expect(result.dateField.getDate()).toBe(25);
    });

    it('should parse datetime with milliseconds (yyyy-MM-dd HH:mm:ss.SSS)', () => {
      // Arrange
      const input = { dateField: '2023-12-25 10:30:45.123' };

      // Act
      const result = plainToInstance(TestDto, input);

      // Assert
      expect(result.dateField).toBeInstanceOf(Date);
      expect(result.dateField.getMilliseconds()).toBe(123);
    });

    it('should parse datetime with milliseconds and timezone (yyyy-MM-dd HH:mm:ss.SSSZ)', () => {
      // Arrange
      const input = { dateField: '2023-12-25 10:30:45.123+0800' };

      // Act
      const result = plainToInstance(TestDto, input);

      // Assert
      expect(result.dateField).toBeInstanceOf(Date);
      expect(result.dateField.getFullYear()).toBe(2023);
    });

    it('should handle Z suffix by replacing with +0000', () => {
      // Arrange
      const input = { dateField: '2023-12-25T10:30:45Z' };

      // Act
      const result = plainToInstance(TestDto, input);

      // Assert
      expect(result.dateField).toBeInstanceOf(Date);
      expect(result.dateField.getFullYear()).toBe(2023);
    });
  });

  describe('数字时间戳解析', () => {
    it('should parse valid timestamp', () => {
      // Arrange
      const timestamp = 1703505045000; // 2023-12-25 10:30:45 UTC
      const input = { dateField: timestamp };

      // Act
      const result = plainToInstance(TestDto, input);

      // Assert
      expect(result.dateField).toBeInstanceOf(Date);
      expect(result.dateField.getTime()).toBe(timestamp);
    });

    it('should throw error for invalid timestamp', () => {
      // Arrange
      const input = { dateField: NaN };

      // Act & Assert
      expect(() => plainToInstance(TestDto, input)).toThrow(
        'Invalid timestamp: NaN',
      );
    });
  });

  describe('Date对象处理', () => {
    it('should return Date object as is', () => {
      // Arrange
      const date = new Date('2023-12-25T10:30:45');
      const input = { dateField: date };

      // Act
      const result = plainToInstance(TestDto, input);

      // Assert
      expect(result.dateField).toBeInstanceOf(Date);
      expect(result.dateField.getTime()).toBe(date.getTime());
    });
  });

  describe('null和undefined处理', () => {
    it('should handle null values', () => {
      // Arrange
      const input = { nullableDateField: null };

      // Act
      const result = plainToInstance(TestDto, input);

      // Assert
      expect(result.nullableDateField).toBeNull();
    });

    it('should handle undefined values', () => {
      // Arrange
      const input = {};

      // Act
      const result = plainToInstance(TestDto, input);

      // Assert
      expect(result.optionalDateField).toBeUndefined();
    });
  });

  describe('错误处理', () => {
    it('should throw error for unsupported date format', () => {
      // Arrange
      const input = { dateField: 'invalid-date-format' }; // 不支持的格式

      // Act & Assert
      expect(() => plainToInstance(TestDto, input)).toThrow(
        'Unsupported date format: invalid-date-format',
      );
    });

    it('should throw error for invalid date string', () => {
      // Arrange
      const input = { dateField: '2023-13-45T25:70:80' }; // 无效的日期值

      // Act & Assert
      expect(() => plainToInstance(TestDto, input)).toThrow(
        'Invalid date value: 2023-13-45T25:70:80',
      );
    });

    it('should throw error for unsupported value type', () => {
      // Arrange
      const input = { dateField: true }; // 布尔类型不支持

      // Act & Assert
      expect(() => plainToInstance(TestDto, input)).toThrow(
        'Unsupported date value type: boolean',
      );
    });

    it('should throw error for object type', () => {
      // Arrange
      const input = { dateField: { year: 2023, month: 12, day: 25 } };

      // Act & Assert
      expect(() => plainToInstance(TestDto, input)).toThrow(
        'Unsupported date value type: object',
      );
    });
  });

  describe('边界情况', () => {
    it('should handle leap year date', () => {
      // Arrange
      const input = { dateField: '2024-02-29' }; // 闰年2月29日

      // Act
      const result = plainToInstance(TestDto, input);

      // Assert
      expect(result.dateField).toBeInstanceOf(Date);
      expect(result.dateField.getFullYear()).toBe(2024);
      expect(result.dateField.getMonth()).toBe(1); // 2月
      expect(result.dateField.getDate()).toBe(29);
    });

    it('should handle year 1970', () => {
      // Arrange
      const input = { dateField: '1970-01-01T00:00:00' };

      // Act
      const result = plainToInstance(TestDto, input);

      // Assert
      expect(result.dateField).toBeInstanceOf(Date);
      expect(result.dateField.getFullYear()).toBe(1970);
    });

    it('should handle future date', () => {
      // Arrange
      const input = { dateField: '2099-12-31T23:59:59' };

      // Act
      const result = plainToInstance(TestDto, input);

      // Assert
      expect(result.dateField).toBeInstanceOf(Date);
      expect(result.dateField.getFullYear()).toBe(2099);
    });
  });
});

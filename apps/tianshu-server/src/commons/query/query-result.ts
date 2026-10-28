import { ApiProperty, ApiSchema } from '@nestjs/swagger';

@ApiSchema({
  name: 'QueryResult',
  description: '查询结果对象',
})
export class QueryResult<T> {
  @ApiProperty({
    description: '页码，从1开始',
    example: '1',
  })
  page: number;
  @ApiProperty({
    description: '每页数量',
    example: 100,
  })
  pageSize: number;
  @ApiProperty({
    description: '数据列表',
    example: null,
  })
  records: T[];

  @ApiProperty({
    description: '总记录数',
    example: 1000,
  })
  total: number;

  constructor(page: number, pageSize: number, records: T[], total: number) {
    this.page = page <= 0 ? 1 : page;
    this.pageSize = pageSize;
    this.records = records;
    this.total = total;
  }

  static of<T>(records: T[], page: number, pageSize: number, total: number) {
    return new QueryResult(page, pageSize, records, total);
  }
}

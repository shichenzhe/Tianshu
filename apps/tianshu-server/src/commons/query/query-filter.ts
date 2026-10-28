import { ApiProperty, ApiSchema } from '@nestjs/swagger';

@ApiSchema({
  name: 'QueryFilter',
  description: '查询过滤对象',
})
export class QueryFilter {
  @ApiProperty({
    description: '页码，从1开始',
    example: '1',
  })
  page: number = 1;
  @ApiProperty({
    description: '每页数量',
    example: 100,
  })
  pageSize: number = 100;

  sorts?: QuerySort[];
}
@ApiSchema({
  name: 'QuerySort',
  description: '排序对象',
})
export class QuerySort {
  @ApiProperty({
    description: '排序字段',
    example: 'createdAt',
  })
  field: string;
  @ApiProperty({
    description: '排序方向',
    example: 'asc',
  })
  direction: 'asc' | 'desc';
}

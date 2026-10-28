import { ApiProperty, ApiSchema } from '@nestjs/swagger';
import { Entity } from './entity';

@ApiSchema({
  name: 'UcnEntity',
  description: 'ucn实体',
})
export class UcnEntity extends Entity {
  @ApiProperty({
    description: '代码',
    example: '001',
  })
  code: string;
  @ApiProperty({
    description: '名称',
    example: '张三',
  })
  name: string;

  constructor(partial: Partial<any>) {
    super(partial);
    Object.assign(this, partial);
  }
}

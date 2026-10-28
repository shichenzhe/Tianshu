import { ApiProperty, ApiSchema } from '@nestjs/swagger';
import { Entity } from './entity';

@ApiSchema({
  name: 'IdNameEntity',
  description: 'idName实体',
})
export class IdNameEntity extends Entity {
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

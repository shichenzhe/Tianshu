import { ApiProperty, ApiSchema } from '@nestjs/swagger';

@ApiSchema({
  name: 'ResponseDto',
  description: '响应对象',
})
export class ResponseDto<T> {
  @ApiProperty({
    description: '响应码',
    example: '2000',
  })
  code: string;
  @ApiProperty({
    description: '响应是否成功',
    example: true,
  })
  success: boolean;
  @ApiProperty({
    description: '响应数据',
    example: null,
  })
  data: T | null;
  @ApiProperty({
    description: '响应消息',
    example: '操作成功',
  })
  message: string;
}

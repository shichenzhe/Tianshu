import { IsInt, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** workspace/delete 载荷（A8 批）：目标空间 id */
export class WorkspaceIdDto {
  @ApiProperty({ description: '工作空间标识' })
  @IsNotEmpty({ message: '工作空间标识不能为空' })
  @IsInt({ message: '工作空间标识必须是整数' })
  id: number;
}

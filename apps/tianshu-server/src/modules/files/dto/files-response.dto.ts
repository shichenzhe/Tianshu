import { ApiProperty } from '@nestjs/swagger';
import type { RemoteFileContent } from '@tianshu/protocol';

/**
 * files 域响应DTO（SK-R 批）：read/uploadImage 形状 implements 协议包
 * 类型编译期绑定；list 为 string[] 直 inline（无 class）
 */
export class RemoteFileContentDto implements RemoteFileContent {
  @ApiProperty({ description: '文件文本内容（512KB 守卫上限内）' })
  content: string;
}

export class RemoteFileUploadResultDto {
  @ApiProperty({ description: '落盘相对路径（attachments/ 下）' })
  imagePath: string;
}

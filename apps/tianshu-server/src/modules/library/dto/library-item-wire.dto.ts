import { ApiProperty } from '@nestjs/swagger';
import type { LibraryItemDto, LibraryItemKind } from '@tianshu/protocol';

/**
 * 资料库条目 wire 响应DTO（SDK 响应面批）：wire 形状 = 协议包
 * LibraryItemDto（class implements 编译期绑定——协议改形此处编译红）。
 * storagePath/originalPath 本机绝对路径刻意不入 DTO（协议包 ruling：
 * 不作远程读取凭证）；时间字段 wire 口径 ISO 字符串。
 */
export class LibraryItemWireDto implements LibraryItemDto {
  @ApiProperty({ description: '条目标识' })
  id: number;

  @ApiProperty({
    description: '父目录 id（null=根层）',
    type: 'number',
    nullable: true,
  })
  parentId: number | null;

  @ApiProperty({ description: '名称' })
  name: string;

  @ApiProperty({ description: '条目类型', enum: ['folder', 'file', 'link'] })
  kind: LibraryItemKind;

  @ApiProperty({
    description: '文件类型（file 扩展名分类；folder/link null）',
    nullable: true,
  })
  fileType: string | null;

  @ApiProperty({ description: 'MIME 类型（推断；可能 null）', nullable: true })
  mimeType: string | null;

  @ApiProperty({
    description: '字节数（file；folder/link null）',
    type: 'number',
    nullable: true,
  })
  size: number | null;

  @ApiProperty({ description: '链接地址（link；其余 null）', nullable: true })
  url: string | null;

  @ApiProperty({ description: '收藏标记' })
  favorite: boolean;

  @ApiProperty({
    description: '最近访问时间（ISO；null=未看过）',
    nullable: true,
  })
  lastViewedAt: string | null;

  @ApiProperty({
    description: '位置链（根→父的 folder 名序列）',
    type: [String],
  })
  location: string[];

  @ApiProperty({ description: '创建时间（ISO）' })
  createdAt: string;

  @ApiProperty({ description: '更新时间（ISO）' })
  updatedAt: string;
}

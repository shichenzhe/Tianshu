/**
 * 资料库面控制器（library 批，spec 2026-10-26 §1.1）：十八端点全对齐
 * 协议 ENDPOINTS.library（list/tree/search/listRecent/listFavorites/
 * createFolder/createFile/addLink/rename/move/delete/subtreeCount/
 * toggleFavorite/markViewed/read/readImage/writeContent/uploadFile）——POST
 * 风格照
 * skills 模块先例；载荷形状对齐 mirror server-face routes.ts library
 * 处理器（name 非空 trim 255 / ids 非空整数数组 / url 限 http(s) /
 * parentId null=根层）。@Public() 豁免 JWT（无头端 token 为实例级——
 * skills/files 同口径），StaticTokenGuard 全局仍守。稳定错误码
 * LIBRARY_* 由服务层 BusinessException 承载。
 */
import { Controller, Post, Body, HttpStatus, HttpCode } from '@nestjs/common';
import {
  ApiOperation,
  ApiExtraModels,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { Public } from 'src/commons/auth/decorator/public.decorator';
import {
  ApiWrappedOk,
  inlineSchemas,
} from 'src/commons/swagger/wrapped-response';
import { LibraryItemWireDto } from './dto/library-item-wire.dto';
import { LibraryService } from './library.service';

class LibraryParentId {
  @ApiPropertyOptional({
    description: '父目录 id（缺省/null=根层）',
    nullable: true,
  })
  @IsOptional()
  @IsInt({ message: 'parentId 必须是整数' })
  parentId?: number | null;
}

class LibraryListDto extends LibraryParentId {}

class LibrarySearchDto {
  @ApiProperty({ description: '搜索关键词（trim 后截 100）' })
  @IsNotEmpty({ message: 'keyword 不能为空' })
  @IsString({ message: 'keyword 必须是字符串' })
  @MaxLength(100, { message: 'keyword 长度不能超过100位' })
  keyword: string;
}

class LibraryCreateDto {
  @ApiProperty({ description: '名称（服务端清洗非法字符+同层重名序号）' })
  @IsNotEmpty({ message: 'name 不能为空' })
  @IsString({ message: 'name 必须是字符串' })
  @MaxLength(255, { message: 'name 长度不能超过255位' })
  name: string;

  @ApiPropertyOptional({
    description: '父目录 id（缺省/null=根层）',
    nullable: true,
  })
  @IsOptional()
  @IsInt({ message: 'parentId 必须是整数' })
  parentId?: number | null;
}

class LibraryAddLinkDto {
  @ApiProperty({ description: '链接地址（仅 http/https）' })
  @IsNotEmpty({ message: 'url 不能为空' })
  @IsString({ message: 'url 必须是字符串' })
  @Matches(/^https?:\/\//i, { message: 'url 仅支持 http/https' })
  url: string;

  @ApiPropertyOptional({ description: '标题（缺省取域名）', nullable: true })
  @IsOptional()
  @IsString({ message: 'title 必须是字符串' })
  @MaxLength(255, { message: 'title 长度不能超过255位' })
  title?: string | null;

  @ApiPropertyOptional({
    description: '父目录 id（缺省/null=根层）',
    nullable: true,
  })
  @IsOptional()
  @IsInt({ message: 'parentId 必须是整数' })
  parentId?: number | null;
}

class LibraryRenameDto {
  @ApiProperty({ description: '条目 id' })
  @IsInt({ message: 'id 必须是整数' })
  id: number;

  @ApiProperty({ description: '新名称（file 重命名磁盘同步双写）' })
  @IsNotEmpty({ message: 'name 不能为空' })
  @IsString({ message: 'name 必须是字符串' })
  @MaxLength(255, { message: 'name 长度不能超过255位' })
  name: string;
}

class LibraryMoveDto {
  @ApiProperty({ description: '待移动条目 id 数组（非空）', type: [Number] })
  @ArrayNotEmpty({ message: 'ids 不能为空数组' })
  @IsArray({ message: 'ids 必须是数组' })
  @IsInt({ each: true, message: 'ids 元素必须是整数' })
  ids: number[];

  @ApiPropertyOptional({
    description: '目标目录 id（缺省/null=根层；拒绝自身/后代成环）',
    nullable: true,
  })
  @IsOptional()
  @IsInt({ message: 'targetParentId 必须是整数' })
  targetParentId?: number | null;
}

class LibraryDeleteDto {
  @ApiProperty({
    description: '待删除条目 id 数组（级联子树+清盘）',
    type: [Number],
  })
  @ArrayNotEmpty({ message: 'ids 不能为空数组' })
  @IsArray({ message: 'ids 必须是数组' })
  @IsInt({ each: true, message: 'ids 元素必须是整数' })
  ids: number[];
}

class LibraryIdDto {
  @ApiProperty({ description: '条目 id' })
  @IsInt({ message: 'id 必须是整数' })
  id: number;
}

class LibraryWriteContentDto {
  @ApiProperty({ description: '条目 id（仅 file）' })
  @IsInt({ message: 'id 必须是整数' })
  id: number;

  @ApiProperty({ description: '全量覆写文本内容（≤512KiB，utf8）' })
  @IsString({ message: 'content 必须是字符串' })
  content: string;
}

class LibraryUploadFileDto {
  @ApiPropertyOptional({
    description: '父目录 id（缺省/null=根层）',
    nullable: true,
  })
  @IsOptional()
  @IsInt({ message: 'parentId 必须是整数' })
  parentId?: number | null;

  @ApiProperty({
    description: '文件名（服务端清洗非法字符+同层重名序号）',
  })
  @IsNotEmpty({ message: 'name 不能为空' })
  @IsString({ message: 'name 必须是字符串' })
  @MaxLength(255, { message: 'name 长度不能超过255位' })
  name: string;

  @ApiProperty({ description: '文件内容 base64（服务端解码 ≤3MB 校验）' })
  @IsNotEmpty({ message: 'base64 不能为空' })
  @IsString({ message: 'base64 必须是字符串' })
  base64: string;
}

@ApiTags('资料库')
@Public()
@ApiExtraModels(LibraryItemWireDto)
@Controller('library')
export class LibraryController {
  constructor(private readonly libraryService: LibraryService) {}

  @Post('list')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '单层列表 + 面包屑' })
  @ApiWrappedOk({
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: { $ref: getSchemaPath(LibraryItemWireDto) },
      },
      breadcrumbs: {
        type: 'array',
        items: { $ref: getSchemaPath(LibraryItemWireDto) },
      },
    },
    required: ['items', 'breadcrumbs'],
  })
  async list(@Body() dto: LibraryListDto) {
    return await this.libraryService.list(dto.parentId ?? null);
  }

  @Post('tree')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '全量条目平铺（树形栏数据源）' })
  @ApiWrappedOk({
    type: 'array',
    items: { $ref: getSchemaPath(LibraryItemWireDto) },
  })
  async tree() {
    return await this.libraryService.tree();
  }

  @Post('search')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '跨层文件名搜索（仅 file）' })
  @ApiWrappedOk({
    type: 'array',
    items: { $ref: getSchemaPath(LibraryItemWireDto) },
  })
  async search(@Body() dto: LibrarySearchDto) {
    return await this.libraryService.search(dto.keyword);
  }

  @Post('listRecent')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '最近访问（file 且已看，倒序限 50）' })
  @ApiWrappedOk({
    type: 'array',
    items: { $ref: getSchemaPath(LibraryItemWireDto) },
  })
  async listRecent() {
    return await this.libraryService.listRecent();
  }

  @Post('listFavorites')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '全局收藏（favorite 的 file）' })
  @ApiWrappedOk({
    type: 'array',
    items: { $ref: getSchemaPath(LibraryItemWireDto) },
  })
  async listFavorites() {
    return await this.libraryService.listFavorites();
  }

  @Post('createFolder')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '新建文件夹（清洗+同层重名序号）' })
  @ApiWrappedOk(LibraryItemWireDto)
  async createFolder(@Body() dto: LibraryCreateDto) {
    return await this.libraryService.createFolder(
      dto.name,
      dto.parentId ?? null,
    );
  }

  @Post('createFile')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '新建空文件（磁盘落空内容，size 0）' })
  @ApiWrappedOk(LibraryItemWireDto)
  async createFile(@Body() dto: LibraryCreateDto) {
    return await this.libraryService.createFile(dto.name, dto.parentId ?? null);
  }

  @Post('addLink')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '添加链接（kind=link 纯 DB）' })
  @ApiWrappedOk(LibraryItemWireDto)
  async addLink(@Body() dto: LibraryAddLinkDto) {
    return await this.libraryService.addLink(
      dto.url,
      dto.title ?? null,
      dto.parentId ?? null,
    );
  }

  @Post('rename')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '重命名（file 磁盘同步双写）' })
  @ApiWrappedOk(LibraryItemWireDto)
  async rename(@Body() dto: LibraryRenameDto) {
    return await this.libraryService.rename(dto.id, dto.name);
  }

  @Post('move')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '批量移动（循环防护+撞名序号）' })
  @ApiWrappedOk()
  async move(@Body() dto: LibraryMoveDto): Promise<null> {
    return await this.libraryService.move(dto.ids, dto.targetParentId ?? null);
  }

  @Post('delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '批量删除（子树级联+磁盘清盘）' })
  @ApiWrappedOk()
  async delete(@Body() dto: LibraryDeleteDto): Promise<null> {
    return await this.libraryService.delete(dto.ids);
  }

  @Post('subtreeCount')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '子树内容数（不含自身）' })
  @ApiWrappedOk({ type: 'number' })
  async subtreeCount(@Body() dto: LibraryIdDto): Promise<number> {
    return await this.libraryService.subtreeCount(dto.id);
  }

  @Post('toggleFavorite')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '收藏切换' })
  @ApiWrappedOk(LibraryItemWireDto)
  async toggleFavorite(@Body() dto: LibraryIdDto) {
    return await this.libraryService.toggleFavorite(dto.id);
  }

  @Post('markViewed')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '预览打点（置 lastViewedAt）' })
  @ApiWrappedOk(LibraryItemWireDto)
  async markViewed(@Body() dto: LibraryIdDto) {
    return await this.libraryService.markViewed(dto.id);
  }

  @Post('read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '读文本内容（512KiB/NUL 守卫）' })
  @ApiWrappedOk(inlineSchemas.libraryRead)
  async read(@Body() dto: LibraryIdDto) {
    return await this.libraryService.read(dto.id);
  }

  @Post('readImage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '读图片（mime 白名单+10MB→base64）' })
  @ApiWrappedOk(inlineSchemas.libraryReadImage)
  async readImage(@Body() dto: LibraryIdDto) {
    return await this.libraryService.readImage(dto.id);
  }

  @Post('writeContent')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '全量覆写文本内容（≤512KiB）' })
  @ApiWrappedOk(LibraryItemWireDto)
  async writeContent(@Body() dto: LibraryWriteContentDto) {
    return await this.libraryService.writeContent(dto.id, dto.content);
  }

  @Post('uploadFile')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '上传二进制入库（≤3MB，清洗+重名序号）' })
  @ApiWrappedOk(LibraryItemWireDto)
  async uploadFile(@Body() dto: LibraryUploadFileDto) {
    return await this.libraryService.uploadFile(dto);
  }
}

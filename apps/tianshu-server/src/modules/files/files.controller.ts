import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Public } from 'src/commons/auth/decorator/public.decorator';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiExtraModels } from '@nestjs/swagger';
import {
  RemoteFileContentDto,
  RemoteFileUploadResultDto,
} from './dto/files-response.dto';
import {
  ApiWrappedOk,
  inlineSchemas,
} from 'src/commons/swagger/wrapped-response';
import {
  IsBase64,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { FilesService } from './files.service';

class FilesListDto {
  @ApiProperty({ description: '工作空间 id' })
  @IsInt()
  workspaceId: number;
}

class FilesReadDto {
  @ApiProperty({ description: '工作空间 id' })
  @IsInt()
  workspaceId: number;

  @ApiProperty({ description: '相对路径（/ 分隔）' })
  @IsNotEmpty({ message: '路径不能为空' })
  @IsString({ message: '路径必须是字符串' })
  @MaxLength(1024, { message: '路径长度不能超过1024位' })
  path: string;
}

class FilesUploadImageDto {
  @ApiProperty({ description: '工作空间 id（可缺省——落全局 attachments）' })
  @IsOptional()
  @IsInt()
  workspaceId?: number;

  @ApiProperty({ description: '文件名（后缀定 mime；路径段被剥离）' })
  @IsNotEmpty({ message: '文件名不能为空' })
  @IsString({ message: '文件名必须是字符串' })
  @MaxLength(255, { message: '文件名长度不能超过255位' })
  name: string;

  @ApiProperty({ description: '图片字节 base64（≤3MB 解码前）' })
  @IsNotEmpty({ message: '图片内容不能为空' })
  @IsBase64({}, { message: '图片内容必须是 base64' })
  base64: string;
}

/**
 * 文件面控制器（FA-T1，spec §3.1）：远程文件三端点——@ 联想清单 /
 * 守卫读取 / 图片上传。
 */
@ApiTags('文件')
@Public()
@ApiExtraModels(RemoteFileContentDto, RemoteFileUploadResultDto)
@Controller('files')
export class FilesController {
  constructor(private readonly filesService: FilesService) {}

  @Post('list')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '工作空间文件清单（@ 联想）' })
  @ApiWrappedOk(inlineSchemas.stringArray)
  async list(@Body() dto: FilesListDto) {
    return await this.filesService.list(dto.workspaceId);
  }

  @Post('read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '守卫读取（512KB 文本上限）' })
  @ApiWrappedOk(RemoteFileContentDto)
  async read(@Body() dto: FilesReadDto) {
    return await this.filesService.read(dto.workspaceId, dto.path);
  }

  @Post('uploadImage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '图片上传（≤3MB，落数据根 attachments/）' })
  @ApiWrappedOk(RemoteFileUploadResultDto)
  async uploadImage(@Body() dto: FilesUploadImageDto) {
    return await this.filesService.uploadImage(dto);
  }
}

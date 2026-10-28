import { Controller, Post, Body, HttpStatus, HttpCode } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiExtraModels, getSchemaPath } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Public } from 'src/commons/auth/decorator/public.decorator';
import {
  ApiWrappedOk,
  inlineSchemas,
} from 'src/commons/swagger/wrapped-response';
import { SkillBriefWireDto, SkillStatWireDto } from './dto/skill-wire.dto';
import { SkillsService } from './skills.service';

class SkillSetEnabledDto {
  @ApiProperty({ description: '技能名（frontmatter name）' })
  @IsNotEmpty({ message: '技能名不能为空' })
  @IsString({ message: '技能名必须是字符串' })
  @MaxLength(255, { message: '技能名长度不能超过255位' })
  name: string;

  @ApiProperty({ description: '启用状态' })
  @IsBoolean({ message: '启用状态必须是布尔' })
  enabled: boolean;
}

class SkillReadDto {
  @ApiProperty({ description: '技能名（frontmatter name）' })
  @IsNotEmpty({ message: '技能名不能为空' })
  @IsString({ message: '技能名必须是字符串' })
  @MaxLength(255, { message: '技能名长度不能超过255位' })
  name: string;
}

class SkillInstallUploadDto {
  @ApiProperty({ description: '客户端文件名（仅展示/报错用）' })
  @IsNotEmpty({ message: '文件名不能为空' })
  @IsString({ message: '文件名必须是字符串' })
  @MaxLength(255, { message: '文件名长度不能超过255位' })
  name: string;

  @ApiProperty({ description: 'zip 文件 base64（服务端解码 ≤3MB 校验）' })
  @IsNotEmpty({ message: 'base64 不能为空' })
  @IsString({ message: 'base64 必须是字符串' })
  base64: string;

  @ApiPropertyOptional({
    description: '冲突覆写确认后二次请求带 true（缺省 false 冲突返回）',
  })
  @IsOptional()
  @IsBoolean({ message: 'overwrite 必须是布尔值' })
  overwrite?: boolean;
}

/**
 * 技能面控制器（AL 批）：联想清单 + 读全文。
 */
@ApiTags('技能')
@Public()
@ApiExtraModels(SkillBriefWireDto, SkillStatWireDto)
@Controller('skills')
export class SkillsController {
  constructor(private readonly skillsService: SkillsService) {}

  @Post('query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '技能清单（联想候选）' })
  @ApiWrappedOk({
    type: 'array',
    items: { $ref: getSchemaPath(SkillBriefWireDto) },
  })
  async query() {
    return await this.skillsService.query();
  }

  @Post('read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '读技能全文' })
  @ApiWrappedOk(inlineSchemas.contentText)
  async read(@Body() dto: SkillReadDto) {
    return await this.skillsService.read(dto.name);
  }

  @Post('setEnabled')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '技能启停切换（全局）' })
  @ApiWrappedOk()
  async setEnabled(@Body() dto: SkillSetEnabledDto): Promise<void> {
    await this.skillsService.setEnabled(dto.name, dto.enabled);
  }

  @Post('installUpload')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'zip 上传安装（base64 ≤3MB）' })
  @ApiWrappedOk(inlineSchemas.skillInstall)
  async installUpload(@Body() dto: SkillInstallUploadDto): Promise<unknown> {
    return await this.skillsService.installUpload(dto);
  }

  @Post('stats')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '技能使用统计（事件表聚合）' })
  @ApiWrappedOk({
    type: 'array',
    items: { $ref: getSchemaPath(SkillStatWireDto) },
  })
  async stats() {
    return await this.skillsService.stats();
  }
}

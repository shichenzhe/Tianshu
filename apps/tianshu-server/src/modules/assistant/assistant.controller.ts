import { Controller, Post, Body, HttpStatus, HttpCode } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiExtraModels, getSchemaPath } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Public } from 'src/commons/auth/decorator/public.decorator';
import {
  ApiWrappedOk,
  inlineSchemas,
} from 'src/commons/swagger/wrapped-response';
import { AssistantBriefWireDto } from './dto/assistant-brief.dto';
import { AssistantService } from './assistant.service';

class AssistantExportDto {
  @ApiProperty({ description: '专家 id' })
  @IsInt({ message: 'id 必须是整数' })
  id: number;
}

class AssistantImportDto {
  @ApiProperty({ description: '导出 JSON 文本（服务端 parse 校验）' })
  @IsNotEmpty({ message: 'json 不能为空' })
  @IsString({ message: 'json 必须是字符串' })
  json: string;
}

/**
 * 专家面控制器（远控台会话选专家配套）：只读列表——无头端专家数据
 * 来源后续批（写入面属专家管理远控化）；伴生单用户读自有行。
 * `@Public` 豁免 JWT；静态 token 守卫仍生效。
 */
@ApiTags('专家')
@Public()
@ApiExtraModels(AssistantBriefWireDto)
@Controller('assistant')
export class AssistantController {
  constructor(private readonly assistantService: AssistantService) {}

  /**
   * 专家全量列表（id/name 概要——发送时 assistantId 选用）
   */
  @Post('query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '专家列表（概要）' })
  @ApiWrappedOk({
    type: 'array',
    items: { $ref: getSchemaPath(AssistantBriefWireDto) },
  })
  async query() {
    return await this.assistantService.query();
  }

  /**
   * 导出专家 JSON 文本（A2 尾——归属校验；纯内容面零本机路径）
   */
  @Post('export')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '导出专家（JSON 文本）' })
  @ApiWrappedOk(inlineSchemas.jsonText)
  async export(@Body() dto: AssistantExportDto) {
    return await this.assistantService.export(dto.id);
  }

  /**
   * 导入专家 JSON 文本（A2 尾——parse 校验新建；重名后缀；members 透传）
   */
  @Post('import')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '导入专家（JSON 文本）' })
  @ApiWrappedOk(inlineSchemas.idName)
  async import(@Body() dto: AssistantImportDto) {
    return await this.assistantService.import(dto);
  }
}

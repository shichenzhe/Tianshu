import { Controller, Post, Body, HttpStatus, HttpCode } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiExtraModels } from '@nestjs/swagger';
import {
  ApiWrappedOk,
  inlineSchemas,
} from 'src/commons/swagger/wrapped-response';
import { Public } from 'src/commons/auth/decorator/public.decorator';
import { ProviderService } from './provider.service';
import { ProviderSaveDto } from './dto/provider-save.dto';
import { ProviderDeleteDto } from './dto/provider-delete.dto';
import { ProviderTargetDto } from './dto/provider-target.dto';
import { ProviderBundleDto } from './dto/provider-bundle.dto';

/**
 * 模型配置控制器：天枢控制协议「查存」入口。
 * `@Public` 豁免 JWT 守卫；静态 token 守卫（TIANSHU_TOKEN）仍对本路由生效。
 */
@ApiTags('模型配置')
@Public()
@ApiExtraModels(ProviderBundleDto)
@Controller('provider')
export class ProviderController {
  constructor(private readonly providerService: ProviderService) {}

  /**
   * 查询模型配置全量
   */
  @Post('query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '查询模型配置（providers + models 全量）' })
  @ApiWrappedOk(ProviderBundleDto)
  async query(): Promise<ProviderBundleDto> {
    return await this.providerService.query();
  }

  /**
   * 保存模型配置（upsert 数组：带 id 更新/不带 id 新建）
   */
  @Post('save')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '保存模型配置（upsert 数组语义）' })
  @ApiWrappedOk(ProviderBundleDto)
  async save(@Body() dto: ProviderSaveDto): Promise<ProviderBundleDto> {
    return await this.providerService.save(dto);
  }

  /**
   * 批量删除（providerIds 级联清其 models / modelIds 单删；幂等）
   */
  @Post('delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '删除服务商/模型（批量幂等）' })
  @ApiWrappedOk(ProviderBundleDto)
  async delete(@Body() dto: ProviderDeleteDto): Promise<ProviderBundleDto> {
    return await this.providerService.delete(dto);
  }

  /**
   * 连通测试（轻探上游 /models——可达且鉴权通过即 ok）
   */
  @Post('test')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '服务商连通性测试' })
  @ApiWrappedOk(inlineSchemas.providerTest)
  async test(
    @Body() dto: ProviderTargetDto,
  ): Promise<{ ok: boolean; message: string }> {
    return await this.providerService.test(dto);
  }

  /**
   * 拉取上游模型清单（OpenAI 兼容 /models、ollama /api/tags）
   */
  @Post('fetchModels')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '拉取上游模型清单' })
  @ApiWrappedOk(inlineSchemas.providerFetchModels)
  async fetchModels(@Body() dto: ProviderTargetDto) {
    return await this.providerService.fetchModels(dto);
  }
}

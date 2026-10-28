import { Controller, Post, Body, HttpStatus, HttpCode } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiWrappedOk,
  inlineSchemas,
} from 'src/commons/swagger/wrapped-response';
import { Public } from 'src/commons/auth/decorator/public.decorator';
import { BusinessException } from 'src/commons/exception/bussiness-exception';
import { ErrorCodeEnum } from 'src/commons/exception/error-code.enum';
import { respondBridgeTool } from 'src/core/tools/bridge/bridge-registry';
import { ToolRespondDto, toBridgeToolResult } from './dto/tool-respond.dto';

/**
 * 工具桥控制器（TB-T1，spec §2.2）：POST tool/respond——控制端桌面执行
 * 结果的回传入口（直连 HTTP 与 relay req 帧同达本路由）。requestId
 * 一次性：未知/已消费（重复、超时先收敛、接收者消失先收敛）一律 4005
 * （多控制端并发时首个 respond 生效，spec §7.1）。
 * `@Public` 豁免 JWT 守卫；静态 token 守卫（TIANSHU_TOKEN）仍生效——
 * session/* 协议面同款语义。
 */
@ApiTags('工具桥')
@Public()
@Controller('tool')
export class ToolController {
  @Post('respond')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '桥工具执行结果回传（requestId 一次性，重复/未知 4005）',
  })
  @ApiWrappedOk(inlineSchemas.responded)
  respond(@Body() dto: ToolRespondDto): { responded: true } {
    const responded = respondBridgeTool(
      dto.requestId,
      toBridgeToolResult(dto.result),
    );
    if (!responded) {
      throw new BusinessException(
        'requestId 无效或已应答（一次性——重复/未知/已超时收敛的请求不再受理）',
        ErrorCodeEnum.TOOL_REQUEST_INVALID,
      );
    }
    return { responded: true };
  }
}

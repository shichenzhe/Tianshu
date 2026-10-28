import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import { Public } from 'src/commons/auth/decorator/public.decorator';
import { CAPABILITIES } from '@tianshu/protocol';
import { version } from '../../../package.json';

/**
 * 进程级实例标识：模块加载时生成一次，
 * /info 端点与 main.ts 的 stdout 握手行共用（同一进程同值）
 */
export const instanceId = randomUUID();

/**
 * 服务信息控制器：天枢桌面端发现与 capability 协商入口。
 * `@Public` 豁免 JWT 守卫；静态 token 守卫（TIANSHU_TOKEN）仍对本路由生效。
 * 身份面：TIANSHU_TOKEN 实例级非用户级；数据固定伴生用户（COMPANION_
 * USER_ID=1）——但伴生语义无对应 user 表行（User.id 为 uuid，多用户
 * JWT 映射推迟裁定），username 恒 null（控制端按未知显示，映射落地
 * 后此处改为真实查询）。
 */
@ApiTags('服务信息')
@Public()
@Controller()
export class InfoController {
  @Get('/info')
  @ApiOperation({
    summary: '服务信息与 capability 协商',
    description: '返回服务名、版本、实例标识、能力列表与伴生用户名（starter 统一包装）',
  })
  getInfo() {
    return {
      name: 'tianshu-server',
      version,
      instanceId,
      capabilities: [...CAPABILITIES],
      username: null,
    };
  }
}

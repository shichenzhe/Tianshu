import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UseFilters,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../commons/auth/decorator/public.decorator';
import { ErrorCodeEnum } from '../../commons/exception/error-code.enum';
import { RelayProtocolException } from '../protocol/relay-protocol.exception';
import { RelayProtocolFilter } from '../protocol/relay-protocol.filter';
import { TokenService, RaTokenIssuedResult } from './token.service';

/** Basic 凭证解析结果（akId 作用户名、akSecret 作密码——spec §5.2） */
interface BasicCredentials {
  akId: string;
  akSecret: string;
}

/**
 * 手写 Basic 解析（brief 裁定不走 passport）：base64 解码后**按第一个
 * `:` 切分**（secret 理论上可含冒号——akId 是 UUID 不含，但契约按
 * RFC 7617 惯例切首个）。Buffer base64 解码宽松（非法字符忽略不抛错），
 * 解出无 `:` / 空 akId 一律视为坏凭证 → 401 bad-secret。
 */
function parseBasicAuthorization(
  authorization: string | undefined,
): BasicCredentials | null {
  if (typeof authorization !== 'string') return null;
  const parts = authorization.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0] !== 'Basic') return null;
  const decoded = Buffer.from(parts[1], 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator <= 0) return null;
  return {
    akId: decoded.slice(0, separator),
    akSecret: decoded.slice(separator + 1),
  };
}

/**
 * relay-admin token 换发端点（Task 12，spec §5.1）：`Authorization: Basic
 * base64(akId:akSecret)` → `{accessToken, expiresAt, maxAgeSec}`。
 *
 * **公开路由**（@Public——全局 JwtAuthGuard 是管理员面，本端点是接入方
 * AK 凭证面，二者不同域）；失败经 RelayProtocolFilter 直出 401 +
 * data.reason（协议端点不做管理面 HTTP 200 包装，四端续期循环按状态码
 * 分支）；高频不落审计（spec §6）。
 */
@ApiTags('relay-admin/token')
@Controller('relay-admin/token')
@UseFilters(RelayProtocolFilter)
export class TokenController {
  constructor(private readonly tokenService: TokenService) {}

  @Post()
  @Public()
  @HttpCode(HttpStatus.OK)
  async issue(
    @Headers('authorization') authorization?: string,
  ): Promise<RaTokenIssuedResult> {
    const credentials = parseBasicAuthorization(authorization);
    if (!credentials) {
      throw new RelayProtocolException(
        HttpStatus.UNAUTHORIZED,
        ErrorCodeEnum.UNAUTHORIZED,
        '缺少或格式错误的 Basic 凭证',
        { reason: 'bad-secret' },
      );
    }
    return this.tokenService.issueForAkCredentials(
      credentials.akId,
      credentials.akSecret,
    );
  }
}

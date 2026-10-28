import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import { AppConfig } from '../../config/app-config.entity';

/**
 * 静态 token 守卫
 *
 * 与 JWT 守卫并存：环境变量 TIANSHU_TOKEN 设置时，全局校验
 * `Authorization: Bearer <token>`，SSE 场景（EventSource 无法带自定义
 * header）允许 `?token=<token>` query 等效；未设置时放行（本地开发）。
 *
 * 不感知 @Public——@Public 仅豁免 JWT 守卫，本守卫对全部路由
 * （含 /info、/event 及 controller 级 @Public 路由）一律生效。例外二前缀：
 * - `${contextPath}/webhook/`（终审 F1）——外部系统仅凭每图 token 调用
 *   webhook（spec §4.3 首义），不持 TIANSHU_TOKEN；该前缀由 webhook
 *   每图 token 自鉴权兜底（未知 token 404），守卫放行不构成匿名可达面。
 * - `${contextPath}/backup/`（备份多用户批）——backup 面鉴权自成体系：
 *   BackupGuard 二层兜底（claim=单要素一次性邀请码自鉴权——生成字符集
 *   31 字符、31^8≈8.5e11 组合空间、核销即死，网络爆破不可行；其余=注册表
 *   client/admin 两源 fail-closed）；不豁免则 TIANSHU_TOKEN 部署下备份
 *   客户端 token 被第一层拦死。
 */
/** 守卫只读取的请求字段（fastify 已解析 query 为对象；url 为原始 URL） */
interface TokenRequest {
  headers: { authorization?: string };
  query: { token?: string | string[] };
  /** fastify 原始 URL（含全局前缀 contextPath 与 query 串） */
  url?: string;
}

@Injectable()
export class StaticTokenGuard implements CanActivate {
  /** contextPath 取自 app 配置段（守卫豁免前缀拼装）；无容器场景缺省 '/' */
  constructor(@Optional() private readonly configService?: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.TIANSHU_TOKEN;
    if (!expected) return true;

    const request = context.switchToHttp().getRequest<TokenRequest>();
    if (this.isWebhookPath(request?.url) || this.isBackupPath(request?.url)) {
      return true;
    }
    const provided =
      this.extractBearerToken(request?.headers?.authorization) ??
      request?.query?.token;

    if (typeof provided === 'string' && this.isEqual(provided, expected)) {
      return true;
    }
    throw new UnauthorizedException('无效的访问 token');
  }

  /** 前缀豁免判定公共实现：剥 query 后锚定路径起点前缀比对（子串匹配
   *  会把 `?next=/webhook/` 类 query 误放行——安全面不可）；contextPath
   *  尾斜杠归一（'/' 与 '/api/' 均收敛） */
  private isPrefixedPath(url: string | undefined, segment: string): boolean {
    if (!url) return false;
    const contextPath = (
      this.configService?.get<AppConfig>('app', AppConfig.getDefault()) ??
      AppConfig.getDefault()
    ).contextPath;
    const base = contextPath.replace(/\/+$/, '');
    return url.split('?')[0].startsWith(`${base}/${segment}/`);
  }

  /** `${contextPath}/webhook/` 前缀豁免：每图 token 自鉴权兜底（见类注） */
  private isWebhookPath(url?: string): boolean {
    return this.isPrefixedPath(url, 'webhook');
  }

  /** `${contextPath}/backup/` 前缀豁免：BackupGuard 二层兜底（见类注） */
  private isBackupPath(url?: string): boolean {
    return this.isPrefixedPath(url, 'backup');
  }

  /** 从 Authorization header 提取 Bearer token，非 Bearer scheme 返回 undefined */
  private extractBearerToken(authorization?: string): string | undefined {
    if (!authorization?.startsWith('Bearer ')) return undefined;
    return authorization.slice('Bearer '.length).trim() || undefined;
  }

  /** 定长摘要后 timingSafeEqual，避免逐字节比较引入时序侧信道 */
  private isEqual(provided: string, expected: string): boolean {
    const digest = (value: string) =>
      createHash('sha256').update(value).digest();
    return timingSafeEqual(digest(provided), digest(expected));
  }
}

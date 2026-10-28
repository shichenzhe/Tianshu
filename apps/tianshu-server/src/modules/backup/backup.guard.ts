import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { BackupRegistry } from './backup-registry';

/** 二层备份专用 token（spec §3）：设置时备份端点只认它——日常远控
 *  token 泄漏不暴露整机备份面；未设置回落仅全局 TIANSHU_TOKEN。 */
export const BACKUP_TOKEN_ENV = 'TIANSHU_BACKUP_TOKEN';

/** claim 路由（@Controller('backup') + @Post('claim')）——豁免判定用：
 *  claim 凭单要素一次性邀请码自鉴权（生成字符集 31 字符、31^8≈8.5e11
 *  组合空间、核销即死），不持二层 token——旧「两要素」表述已删（大门
 *  token 对 claim 两层均豁免，不设防，勿据此误安全推演） */
const BACKUP_CLAIM_PATH = 'backup/claim';

/** 双身份（spec 2026-10-28）：client=注册表命中的备份客户端设备；
 *  admin=二层 token（BACKUP_TOKEN ?? TIANSHU_TOKEN）持有者——Task 4/5
 *  据此做 owner 隔离与管理面门禁 */
export interface BackupIdentity {
  kind: 'client' | 'admin';
  clientId?: string;
}

/** guard 读写请求的字段（url 为 fastify 原始 URL，含 query 串） */
interface BackupRequest {
  headers: { authorization?: string };
  url?: string;
  backupIdentity?: BackupIdentity;
}

@Injectable()
export class BackupGuard implements CanActivate {
  constructor(private readonly registry: BackupRegistry) {}

  /** claim 路径同步放行（不注入 identity）；其余路径异步识别。
   *  返回联合类型而非全 async：claim 豁免无 await，同步 true 即刻返回。 */
  canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    const req = context.switchToHttp().getRequest<BackupRequest>();
    if (this.isClaimPath(req?.url)) return true;
    return this.identify(req);
  }

  /** 识别序（spec §5.2）：注册表客户端 → admin token → 401 */
  private async identify(req: BackupRequest): Promise<boolean> {
    const bearer = this.extractBearerToken(req.headers?.authorization);
    if (bearer) {
      const client = await this.registry.findClientByToken(bearer);
      if (client) {
        req.backupIdentity = { kind: 'client', clientId: client.clientId };
        return true;
      }
    }
    const adminToken =
      process.env[BACKUP_TOKEN_ENV] ?? process.env.TIANSHU_TOKEN;
    if (bearer && adminToken && this.isEqual(bearer, adminToken)) {
      req.backupIdentity = { kind: 'admin' };
      return true;
    }
    if (!bearer && !adminToken) {
      // 未设任何 token 且请求未带凭据（本地开发）——现状回落 admin 放行；
      // 带了凭据但注册表/admin 双未命中仍 401（垃圾 token 不静默提权）
      req.backupIdentity = { kind: 'admin' };
      return true;
    }
    throw new UnauthorizedException('无效的备份 token');
  }

  /** claim 豁免判定：剥 query 后比对路由尾段（token.guard.ts isWebhookPath
   *  同款剥 query 防 ?next= 类串入）。claim 是精确单路由而非 webhook 式
   *  子树前缀，锚定尾段对任意 contextPath 前缀部署（含 '/api' 前缀）均
   *  只豁免该路由本身 */
  private isClaimPath(url?: string): boolean {
    if (!url) return false;
    return url.split('?')[0].endsWith(`/${BACKUP_CLAIM_PATH}`);
  }

  /** 从 Authorization header 提取 Bearer token（token.guard.ts 同款） */
  private extractBearerToken(authorization?: string): string | undefined {
    if (!authorization?.startsWith('Bearer ')) return undefined;
    return authorization.slice('Bearer '.length).trim() || undefined;
  }

  /** 定长摘要后 timingSafeEqual（token.guard.ts 同款，防时序侧信道）——
   *  admin 判定两侧均为明文，双摘合法（registry 侧 hash 对 hash 勿双摘） */
  private isEqual(a: string, b: string): boolean {
    const digest = (v: string) => createHash('sha256').update(v).digest();
    return timingSafeEqual(digest(a), digest(b));
  }
}

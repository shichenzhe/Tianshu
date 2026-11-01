/**
 * 统一数据根解析（config 口径单点）：config tianshu.dataRoot（缺省
 * ~/.tianshu-server）经 resolveDataRoot（TIANSHU_DATA_ROOT 环境变量可
 * 覆盖——测试隔离同源）。
 * chat（chat-core.module）/automation（automation.module）本就走此口径；
 * files/graph 运行时/library/backup 收敛于此——修复前各处硬编码
 * '~/.tianshu-server' 只认 env，config.yml 调 dataRoot 时这些读写面与
 * chat 侧分裂（图节点技能/资料库/产物目录、prompt 任务技能引用、备份根、
 * 图片上传目录全部留在旧根）。
 */
import { ConfigService } from '@nestjs/config';
import type { TianshuConfig } from './tianshu-config.entity';
import { TianshuConfig as TianshuConfigEntity } from './tianshu-config.entity';
import { resolveDataRoot } from '../util/path.util';

export function tianshuDataRoot(configService: ConfigService): string {
  const tianshu = configService.get<TianshuConfig>(
    'tianshu',
    TianshuConfigEntity.getDefault(),
  );
  return resolveDataRoot(tianshu.dataRoot);
}

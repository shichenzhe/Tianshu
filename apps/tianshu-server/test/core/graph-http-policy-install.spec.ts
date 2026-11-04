/**
 * 图编排 HTTP 节点守卫策略装配（逃生口 2026-11-04）单测：
 * installGraphHttpGuardPolicy 后 graph-executor 模块单例策略生效——
 * config.yml tianshu.graph 段 → seam 读出口形状；缺段缺省严拦。
 * （installSecurityGates / security-gate-install.spec 同款形态）
 */
import { installGraphHttpGuardPolicy } from 'src/core/chat-core.module';
import {
  installGraphHttpUrlPolicy,
  currentGraphHttpUrlPolicy,
} from 'src/core/graph/graph-executor';
import type { TianshuConfig } from 'src/commons/config/tianshu-config.entity';

/** ConfigService 最小替身（装配函数只消费 .get） */
const configOf = (config: Partial<TianshuConfig>): never =>
  ({ get: () => config }) as never;

describe('installGraphHttpGuardPolicy（HTTP 守卫策略装配）', () => {
  afterEach(() => {
    // 复装缺省严拦，避免模块单例污染其他套件
    installGraphHttpUrlPolicy(() => ({
      allowPrivateNetwork: false,
      allowlist: [],
    }));
  });

  it('graph 段配置透传：allowPrivateNetwork 与 allowlist 形状一致', () => {
    installGraphHttpGuardPolicy(
      configOf({
        dataRoot: '~/.tianshu-server',
        graph: {
          allowPrivateNetwork: false,
          allowlist: ['192.168.1.0/24', 'jira6.app.hd123.cn'],
        },
      }),
    );
    expect(currentGraphHttpUrlPolicy()).toEqual({
      allowPrivateNetwork: false,
      allowlist: ['192.168.1.0/24', 'jira6.app.hd123.cn'],
    });
  });

  it('缺 graph 段缺省严拦（S5/F1 语义零变化）', () => {
    installGraphHttpGuardPolicy(
      configOf({ dataRoot: '~/.tianshu-server' }),
    );
    expect(currentGraphHttpUrlPolicy()).toEqual({
      allowPrivateNetwork: false,
      allowlist: [],
    });
  });

  it('闭包实时读：装配后改配置对象即时生效（文件配置重启粒度的内存面）', () => {
    const config: { tianshu: Partial<TianshuConfig> } = {
      tianshu: { dataRoot: '~/.tianshu-server' },
    };
    const cs = { get: () => config.tianshu };
    installGraphHttpGuardPolicy(cs as never);
    expect(currentGraphHttpUrlPolicy().allowPrivateNetwork).toBe(false);
    config.tianshu.graph = {
      allowPrivateNetwork: true,
      allowlist: [],
    };
    expect(currentGraphHttpUrlPolicy().allowPrivateNetwork).toBe(true);
  });
});

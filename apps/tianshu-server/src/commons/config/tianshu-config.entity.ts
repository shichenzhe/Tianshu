/**
 * 天枢桌面端联动配置（config.yml `tianshu` 段）
 */
export class TianshuConfig {
  // 数据根目录（与桌面端 ~/.tianshu 隔离）
  dataRoot: string;
  // 聊天配置
  chat?: TianshuChatConfig;
  // 自动化调度配置（GA-T5：scheduler tick 间隔可配，E2E/测试缩短用）
  automation?: TianshuAutomationConfig;
  // 桌面工具桥配置（TB-T1：桥调用超时可配，E2E/测试缩短用）
  bridge?: TianshuBridgeConfig;
  // relay 客户端配置（E2E-T2：端到端加密模式）
  relay?: TianshuRelayConfig;
  // 是否启用与桌面端的握手
  handshake: boolean;

  static getDefault(): TianshuConfig {
    const defaultConfig = new TianshuConfig();
    defaultConfig.dataRoot = '~/.tianshu-server';
    defaultConfig.chat = TianshuChatConfig.getDefault();
    defaultConfig.automation = TianshuAutomationConfig.getDefault();
    defaultConfig.bridge = TianshuBridgeConfig.getDefault();
    defaultConfig.relay = TianshuRelayConfig.getDefault();
    defaultConfig.handshake = true;
    return defaultConfig;
  }
}

/** relay E2E 模式（spec 2026-10-18-relay-e2e §2.4 降级语义）：auto 缺省
 * （未握手明文兼容旧控制端）/ required（拒明文业务帧）/ off（忽略 hello） */
export type RelayE2eMode = 'auto' | 'required' | 'off';

/**
 * 天枢 relay 客户端配置（config.yml `tianshu.relay` 段，E2E-T2）
 */
export class TianshuRelayConfig {
  e2e: RelayE2eMode;

  static getDefault(): TianshuRelayConfig {
    const defaultConfig = new TianshuRelayConfig();
    defaultConfig.e2e = 'auto';
    return defaultConfig;
  }
}

/**
 * 天枢桌面工具桥配置（config.yml `tianshu.bridge` 段，TB-T1）
 */
export class TianshuBridgeConfig {
  /** 桥调用超时（毫秒，缺省 30000——控制端桌面执行+审批等待合计；
   * spec §4.2 审批等待计入工具超时，用户可经此调大） */
  timeoutMs: number;

  static getDefault(): TianshuBridgeConfig {
    const defaultConfig = new TianshuBridgeConfig();
    defaultConfig.timeoutMs = 30_000;
    return defaultConfig;
  }
}

/**
 * 天枢自动化调度配置（config.yml `tianshu.automation` 段，GA-T5）
 */
export class TianshuAutomationConfig {
  /** 调度器 tick 间隔（毫秒，缺省 30000——mirror AutomationScheduler 同值；
   * server 常驻无头端，E2E/测试经此缩短快进） */
  tickMs: number;

  static getDefault(): TianshuAutomationConfig {
    const defaultConfig = new TianshuAutomationConfig();
    defaultConfig.tickMs = 30_000;
    return defaultConfig;
  }
}

/**
 * 工具审批模式（manual=挂起等远程应答，超时自动 deny；移动端 spec §4.3）
 */
export type ChatAccessMode = 'default' | 'auto-approve' | 'manual';

/**
 * 天枢聊天配置
 */
export class TianshuChatConfig {
  // 是否允许危险工具
  allowDangerousTools: boolean;
  // 删除保护：true（缺省）= rm 移入回收目录；false = 永久删除
  // （T6 复审 M3：自硬编码挪 config，mirror dataSafety 闭包的 config 面等价）
  deleteProtection: boolean;
  // 工具审批模式：default（缺省）= 需审批操作（写/门禁 ask）自动拒绝，文案
  // 提示 config 放行；auto-approve = 静默放行（等价 mirror 会话 full 模式）；
  // manual = 挂起等远程应答（session/approve 端点决议）
  accessMode: ChatAccessMode;
  // 审批挂起上限（manual 模式）：毫秒，缺省 300_000（5 分钟）超时自动 deny
  approvalTimeoutMs?: number;

  static getDefault(): TianshuChatConfig {
    const defaultConfig = new TianshuChatConfig();
    defaultConfig.allowDangerousTools = false;
    defaultConfig.deleteProtection = true;
    defaultConfig.accessMode = 'default';
    return defaultConfig;
  }
}

/**
 * 伴生模式固定用户（T1 裁定）：摘表 userId 为 Int 普通列无外键，
 * 本地伴生语义写死 userId=1（DTO 不收 userId）；JWT 多用户映射推迟到需要时再裁定。
 */
export const COMPANION_USER_ID = 1;

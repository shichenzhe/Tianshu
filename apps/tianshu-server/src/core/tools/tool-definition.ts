/**
 * 工具定义与执行上下文（自 mirror electron/domains/ai/agent/file-tools.ts 的
 * ToolContext/ToolDefinition 摘出为独立模块——本仓 file-tools 只承载五件
 * 文件工具本体；无头端裁剪：emitPanel（浏览器面板联动）与
 * commandWatchBlacklist（SP2 子进程监控，依赖 electron child-monitor）不移植。
 */
import type { z } from 'zod';
import type { SecurityEventSink } from './security-events';

export interface ToolContext {
  workspacePath: string;
  /** 图执行无会话传 null（2026-10-28 去会话化）：审计事件 sessionId 可
   *  空、备份回调容忍（file-history 0/ 目录语义同 mirror）、桥工具照常
   *  发起（桥窗与本地会话 tab 无关） */
  sessionId: number | null;
  /** 会话归属用户 id：按用户隔离的落库工具消费（plan_、create_skill 等） */
  userId?: number;
  /** 会话绑定工作空间 id（落库依据）；未绑定目录的会话为 undefined */
  workspaceId?: number;
  /** 会话当前模型 id；未选为 undefined */
  modelId?: number;
  /** 完全访问：true 时文件工具跳过工作空间边界校验（缺省 false=现状） */
  fullAccess?: boolean;
  /** 会话级路径授权清单：workspace 外的授权绝对路径放行（read/list 直读） */
  grantedPaths?: string[];
  /** 会话归属项目 id：plan_* 工具属地依据，非项目会话 null */
  projectId?: number | null;
  /** 安全事件上报：工具按需消费（如 run_command 拦截/cwd 回退） */
  onSecurityEvent?: SecurityEventSink;
  /** 删除保护：true=移入服务端回收目录；装配注入，缺省 true 与默认配置一致 */
  deleteProtection?: boolean;
  /** 回收目录根（deleteProtection=true 时 delete_file 移入；缺省 ~/.tianshu-server/trash） */
  trashRoot?: string;
  /** 备份回调（write_file 覆盖前 / delete_file 永久删除前）；缺省不备份 */
  onBackupFile?: (
    absPath: string,
    sessionId: number | null,
  ) => Promise<BackupFileResult>;
  /** 写盘后回调（文件变更通知）；缺席不通知 */
  onFileWritten?: (absPath: string) => void;
}

/** 备份结果形状（mirror security/file-history 同构；本仓暂不接备份服务，仅保留契约） */
export type BackupFileResult =
  { ok: true; size: number } | { ok: false; reason: string };

export interface ToolDefinition<TArgs = unknown> {
  name: string;
  description: string;
  /** zod schema（内置工具）或 JSON Schema 对象（预留 MCP 通道） */
  parameters: z.ZodType<TArgs> | object;
  kind: 'read' | 'write';
  /** 方法签名（非属性）以保持 ToolDefinition<T> 到 ToolDefinition<unknown> 的可赋值性 */
  execute(ctx: ToolContext, args: TArgs): Promise<string>;
}

// ChatRunner 级测试共用夹具（chat-runner.spec / session-send.spec M2-M3 用例）：
// 临时目录、造数（provider/model/workspace/session）、runner 构造（scripted 假模型注入）。
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ChatRunnerService,
  type ChatRunnerConfig,
} from 'src/core/chat-runner.service';
import type { TestDb } from './test-db';
import {
  ScriptedChatModel,
  type StepScript,
} from '../helpers/scripted-chat-model';

/** 临时数据根/工作空间夹具 */
export interface TestDirs {
  dataRoot: string;
  workspace: string;
  cleanup: () => void;
}

export function makeDirs(prefix = 'tianshu-runner-'): TestDirs {
  const base = mkdtempSync(join(tmpdir(), prefix));
  const workspace = join(base, 'ws');
  // 工作空间目录即建（file 工具 resolveSafePath/直接写盘夹具依赖存在）
  mkdirSync(workspace, { recursive: true });
  return {
    dataRoot: join(base, 'data'),
    workspace,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

/** 造数：provider + model + workspace + session（默认绑定工作空间目录）。
 * workspace 名带自增序号——schema 对 (userId, name) 唯一（spec §13 项 5），
 * 同一测试库多次 seedSession 需异名 */
let workspaceSeq = 0;

export async function seedSession(
  db: TestDb,
  dirs: TestDirs,
  sessionOverrides: Record<string, unknown> = {},
): Promise<{
  session: { id: number; currentModelId: number | null };
  model: { id: number };
}> {
  const provider = await db.prisma.provider.create({
    data: {
      name: 'p1',
      type: 'openai-compatible',
      baseUrl: 'http://localhost:9/v1',
      apiKey: 'sk-test',
      userId: 1,
    },
  });
  const model = await db.prisma.model.create({
    data: {
      providerId: provider.id,
      modelId: 'test-model',
      name: '测试模型',
      contextWindow: 8192,
      temperature: 0.3,
    },
  });
  const workspace = await db.prisma.workspace.create({
    data: {
      name: `ws-${++workspaceSeq}`,
      directoryPath: dirs.workspace,
      defaultModelId: model.id,
      userId: 1,
    },
  });
  const session = await db.prisma.sessionRecord.create({
    data: {
      workspaceId: workspace.id,
      currentModelId: model.id,
      title: 't',
      userId: 1,
      ...sessionOverrides,
    },
  });
  return { session, model };
}

/** 每用例新 runner：scripted 模型（脚本数组或现成实例，如挂起模型）注入
 * + 临时数据根配置（可覆盖 runner 配置项） */
export function makeRunner(
  db: TestDb,
  dirs: TestDirs,
  scripts: StepScript[] | ScriptedChatModel,
  configOverrides: Partial<ChatRunnerConfig> = {},
): { runner: ChatRunnerService; model: ScriptedChatModel } {
  const model =
    scripts instanceof ScriptedChatModel
      ? scripts
      : new ScriptedChatModel(scripts);
  const runner = new ChatRunnerService(db.prisma, {
    modelFactory: () => model,
    config: () => ({
      dataRoot: dirs.dataRoot,
      allowDangerousTools: false,
      deleteProtection: true,
      accessMode: 'default',
      ...configOverrides,
    }),
  });
  return { runner, model };
}

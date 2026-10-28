// apps/tianshu-server/test/core/graph-imagegen-comfyui.spec.ts
// imageGen comfyui 副本核心链路（真库 + fetch spy），同构 electron 测试
import { compileStateGraph } from '@tianshu/core';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphRepository } from 'src/modules/graph/graph.repository';
import { executeGraphRun, type GraphRow } from 'src/core/graph/graph-executor';
import {
  installGraphExecutorRuntime,
  resetGraphExecutorRuntime,
  type GraphRunStore,
} from 'src/core/graph/executor-runtime';
import { createTestDb, type TestDb } from '../support/test-db';

const workflowJson = JSON.stringify({
  '3': { class_type: 'KSampler', inputs: { seed: 5 } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } },
  '5': {
    class_type: 'EmptyLatentImage',
    inputs: { width: '{{width}}', height: '{{height}}' },
  },
});

/** /view 应答体：Buffer 池化小串的 .buffer 是整 8KiB 共享池（非精确
 * 切片，落盘断言会读到池内残渣），须按 byteOffset 切出精确 ArrayBuffer */
const viewArrayBuffer = (): ArrayBuffer => {
  const b = Buffer.from('srv-png');
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

function comfyGraphJson(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    inputSchema: { topic: 'string' },
    nodes: [
      {
        id: 'gen',
        name: '生图',
        kind: 'imageGen',
        protocol: 'comfyui',
        providerId: 0, // beforeAll 里回填真实 id
        workflowJson,
        prompt: 'cat {{input.topic}}',
        size: '768x512',
        ...extra,
      },
    ],
    edges: [{ from: 'gen', to: 'END' }],
  });
}

describe('graph-executor imageGen comfyui（副本同构）', () => {
  let db: TestDb;
  let repo: GraphRepository;
  let ws: { id: number };
  let graphRow: GraphRow;
  let assetsDir: string;
  let providerId: number;

  /** /prompt 提交体断言用：prompt 为节点 id → { inputs } 工作流字典 */
  const submitted: Array<{
    prompt: Record<string, { inputs: Record<string, unknown> }>;
  }> = [];
  /** 轮询队列：shift 出队，空则 {}（模拟未完成） */
  const historyQueue: unknown[] = [];

  beforeAll(async () => {
    db = await createTestDb();
    repo = new GraphRepository(db.prisma);
    ws = await db.prisma.workspace.create({
      data: { name: 'comfy-ws', userId: 1 },
    });
    const provider = await db.prisma.provider.create({
      data: {
        name: 'comfy',
        type: 'comfyui',
        baseUrl: 'http://localhost:8188',
        userId: 1,
      },
    });
    providerId = provider.id;
    graphRow = await db.prisma.graphDefinition.create({
      data: {
        name: 'comfy 图',
        graphJson: comfyGraphJson().replace(
          '"providerId":0',
          `"providerId":${providerId}`,
        ),
        userId: 1,
      },
    });
    assetsDir = await mkdtemp(join(tmpdir(), 'comfy-assets-'));
    const statefulRuns: GraphRunStore = {
      createRun: (p) => repo.createRun(p),
      finishRun: (p) => repo.finishRun(p),
    };
    installGraphExecutorRuntime({
      db: db.prisma,
      runs: statefulRuns,
      publishRunUpdated: () => undefined,
      workflowAssetsDir: () => assetsDir,
    });
    jest.spyOn(global, 'fetch').mockImplementation(((
      url: any,
      init?: {
        body?: unknown;
      },
    ) => {
      const u = String(url);
      if (u.endsWith('/prompt')) {
        submitted.push(
          JSON.parse(String(init?.body)) as {
            prompt: Record<string, { inputs: Record<string, unknown> }>;
          },
        );
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({ prompt_id: 'p1', node_errors: {} }),
        };
      }
      if (u.includes('/history/')) {
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve(historyQueue.shift() ?? {}),
        };
      }
      if (u.includes('/view?')) {
        return {
          ok: true,
          status: 200,
          arrayBuffer: () => viewArrayBuffer(),
        };
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as never);
  }, 120_000);

  afterAll(async () => {
    resetGraphExecutorRuntime();
    await rm(assetsDir, { recursive: true, force: true });
    await db.cleanup();
  });

  const runParams = () => ({
    graph: graphRow,
    task: null,
    inputs: { topic: 'cats' },
    triggerType: 'manual' as const,
    attempt: 1,
    abort: new AbortController().signal,
    workspace: { id: ws.id, directoryPath: null },
  });

  const makeDeps = () => ({
    createChatModel: () => {
      throw new Error('comfyui 图不应触达 LLM');
    },
    toLangChainTools: () => [],
    compileStateGraph,
  });

  it('成功链路：占位注入+产物落盘+trace outputImage', async () => {
    historyQueue.push(
      {},
      {
        p1: {
          outputs: {
            '9': {
              images: [{ filename: 'a.png', subfolder: '', type: 'output' }],
            },
          },
        },
      },
    );
    const outcome = await executeGraphRun(runParams(), makeDeps());
    expect(outcome).toBe('success');
    expect(submitted.at(-1)!.prompt['6'].inputs.text).toBe('cat cats');
    expect(submitted.at(-1)!.prompt['5'].inputs.width).toBe(768);
    expect(submitted.at(-1)!.prompt['3'].inputs.seed).not.toBe(5);
    const run = await db.prisma.automationRun.findFirst({
      where: { graphId: graphRow.id },
      orderBy: { id: 'desc' },
    });
    const trace = JSON.parse(run!.graphTrace!) as Array<{
      outputImage?: string;
      error?: { code: string };
    }>;
    expect(trace[0].outputImage).toMatch(/^workflow-assets\/image-\d+\.png$/);
    const abs = join(
      assetsDir,
      trace[0].outputImage!.replace('workflow-assets/', ''),
    );
    expect((await readFile(abs)).toString()).toBe('srv-png');
  }, 20_000);

  it('node_errors 非空 → comfyui_api_error', async () => {
    jest.spyOn(global, 'fetch').mockImplementationOnce((() => ({
      ok: false,
      status: 400,
      json: () =>
        Promise.resolve({
          error: {},
          node_errors: { '3': { errors: [{}] } },
        }),
    })) as never);
    const outcome = await executeGraphRun(runParams(), makeDeps());
    expect(outcome).toBe('failed');
    const run = await db.prisma.automationRun.findFirst({
      where: { graphId: graphRow.id },
      orderBy: { id: 'desc' },
    });
    const trace = JSON.parse(run!.graphTrace!) as Array<{
      outputImage?: string;
      error?: { code: string };
    }>;
    expect(trace[0].error!.code).toBe('comfyui_api_error');
  });
});

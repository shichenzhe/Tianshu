// @vitest-environment jsdom
// 编排页主机路由化（orchestration 批 2026-11-10）：
// - 本地主机：GraphApi 数据面 invoke 原通道参数逐字（零行为变化）
// - 远程主机：list/create/update/remove/toggle/runs/runNodes/runTest/
//   cancelTestRun/webhook 三件经 remote-catalog 适配器 → GA-T8+
//   端点（graph.api.ts mock 为边界）
// - runTest 草稿语义：draftJson 与库内不一致先 graphSave 再 run
// - cancelTestRun：查该图 running run → runAbort(runId)；无在途对齐
//   GRAPH_NOT_RUNNING
// - 深水功能门控：polishPrompt/testNode/导入导出远程态 throw
import { describe, expect, it, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@/lib/ipc", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  on: () => () => {},
}));

const remoteGraphApi = vi.hoisted(() => ({
  graphList: vi.fn(),
  graphSave: vi.fn(),
  graphDelete: vi.fn(),
  graphToggle: vi.fn(),
  graphRun: vi.fn(),
  graphRunAbort: vi.fn(),
  graphRuns: vi.fn(),
  graphRunNodes: vi.fn(),
  webhookEnable: vi.fn(),
  webhookDisable: vi.fn(),
  webhookStatus: vi.fn(),
}));
vi.mock("../../src-react/domains/ai/server/api/graph.api", () => ({
  default: remoteGraphApi,
}));

const serverApi = vi.hoisted(() => ({
  listConnections: vi.fn(),
}));
vi.mock("../../src-react/domains/ai/server/api/server.api", () => ({
  default: serverApi,
  requestRemote: vi.fn(),
  LOCAL_CONNECTION_ID: "local",
  newConnectionId: vi.fn(() => "conn-x"),
  on: () => () => {},
  onRemoteChunk: () => () => {},
  onRemoteEvent: () => () => {},
}));

import {
  useHostStore,
  LOCAL_HOST_CAPS,
} from "../../src-react/domains/ai/data-source/host.store";
import { GraphApi } from "../../src-react/domains/ai/orchestration/api/orchestration.api";

const REMOTE_ROW = {
  id: 7,
  name: "远程图",
  description: null,
  graphJson: '{"nodes":[]}',
  version: 3,
  enabled: true,
  createdAt: "2026-11-10T00:00:00.000Z",
  updatedAt: "2026-11-10T01:00:00.000Z",
  nodeCount: 2,
};

function switchRemote(): void {
  useHostStore.setState({
    activeHost: { kind: "remote", connId: "conn-x" },
    caps: LOCAL_HOST_CAPS,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useHostStore.setState({
    activeHost: { kind: "local" },
    caps: LOCAL_HOST_CAPS,
  });
});

describe("编排页本地主机（零行为变化）", () => {
  it("list/create/toggle/runs：invoke 原通道参数逐字", async () => {
    invoke.mockResolvedValue([]);
    await GraphApi.list();
    expect(invoke).toHaveBeenCalledWith("orchestration:list");
    await GraphApi.create({ name: "n", graphJson: "{}" });
    expect(invoke).toHaveBeenCalledWith("orchestration:create", {
      name: "n",
      graphJson: "{}",
    });
    invoke.mockResolvedValue({});
    await GraphApi.toggle(5, false);
    expect(invoke).toHaveBeenCalledWith("orchestration:toggle", 5, false);
    await GraphApi.runs(5, 1);
    expect(invoke).toHaveBeenCalledWith("orchestration:runs", 5, 1);
    expect(remoteGraphApi.graphList).not.toHaveBeenCalled();
  });

  it("polishPrompt 本地可用（不 throw）", async () => {
    invoke.mockResolvedValue("润色结果");
    await expect(GraphApi.polishPrompt(1, "p")).resolves.toBe("润色结果");
  });
});

describe("编排页远程主机（适配器映射）", () => {
  beforeEach(switchRemote);

  it("list：graphList 全量翻页取完 → GraphRecord 形状", async () => {
    remoteGraphApi.graphList
      .mockResolvedValueOnce({ total: 3, records: [REMOTE_ROW, REMOTE_ROW] })
      .mockResolvedValueOnce({ total: 3, records: [REMOTE_ROW] });
    const rows = await GraphApi.list();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      id: 7,
      name: "远程图",
      description: undefined,
      nodeCount: 2,
      updatedAt: "2026-11-10T01:00:00.000Z",
    });
    expect(remoteGraphApi.graphList).toHaveBeenCalledTimes(2);
  });

  it("create/update：graphSave 全量载荷（update 携 id+version）", async () => {
    remoteGraphApi.graphSave.mockResolvedValue(REMOTE_ROW);
    await GraphApi.create({ name: "新图", graphJson: "{}" });
    expect(remoteGraphApi.graphSave).toHaveBeenCalledWith(
      { name: "新图", graphJson: "{}" },
      "conn-x",
    );
    await GraphApi.update(7, {
      name: "改名",
      graphJson: "{}",
      version: 3,
    });
    expect(remoteGraphApi.graphSave).toHaveBeenLastCalledWith(
      { id: 7, name: "改名", graphJson: "{}", version: 3 },
      "conn-x",
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("remove/toggle/runNodes/webhookDisable：直达端点", async () => {
    remoteGraphApi.graphDelete.mockResolvedValue(undefined);
    await GraphApi.remove(7);
    expect(remoteGraphApi.graphDelete).toHaveBeenCalledWith(7, "conn-x");

    remoteGraphApi.graphToggle.mockResolvedValue(REMOTE_ROW);
    await GraphApi.toggle(7, false);
    expect(remoteGraphApi.graphToggle).toHaveBeenCalledWith(7, false, "conn-x");

    remoteGraphApi.graphRunNodes.mockResolvedValue([]);
    await GraphApi.runNodes(33);
    expect(remoteGraphApi.graphRunNodes).toHaveBeenCalledWith(33, "conn-x");

    remoteGraphApi.webhookDisable.mockResolvedValue({
      enabled: false,
      url: "",
    });
    serverApi.listConnections.mockResolvedValue({ connections: [] });
    await GraphApi.webhookDisable(7);
    expect(remoteGraphApi.webhookDisable).toHaveBeenCalledWith(7, "conn-x");
  });

  it("runTest：draftJson 与库内不一致先 save 再 run（保存后跑语义）", async () => {
    remoteGraphApi.graphList.mockResolvedValue({
      total: 1,
      records: [REMOTE_ROW],
    });
    remoteGraphApi.graphSave.mockResolvedValue(REMOTE_ROW);
    remoteGraphApi.graphRun.mockResolvedValue({ runId: 99 });
    await GraphApi.runTest(7, { a: 1 }, 4, '{"nodes":["draft"]}');
    expect(remoteGraphApi.graphSave).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7, version: 3, graphJson: '{"nodes":["draft"]}' }),
      "conn-x",
    );
    expect(remoteGraphApi.graphRun).toHaveBeenCalledWith(
      7,
      "conn-x",
      { a: 1 },
      4,
    );
  });

  it("runTest：draftJson 与库内一致不重复保存", async () => {
    remoteGraphApi.graphList.mockResolvedValue({
      total: 1,
      records: [REMOTE_ROW],
    });
    remoteGraphApi.graphRun.mockResolvedValue({ runId: 99 });
    await GraphApi.runTest(7, {}, 4, REMOTE_ROW.graphJson);
    expect(remoteGraphApi.graphSave).not.toHaveBeenCalled();
    expect(remoteGraphApi.graphRun).toHaveBeenCalled();
  });

  it("cancelTestRun：查 running run → runAbort(runId)；无在途 GRAPH_NOT_RUNNING", async () => {
    remoteGraphApi.graphRuns.mockResolvedValue({
      total: 1,
      items: [{ id: 55 }],
    });
    remoteGraphApi.graphRunAbort.mockResolvedValue({ aborted: true });
    await GraphApi.cancelTestRun(7);
    expect(remoteGraphApi.graphRuns).toHaveBeenCalledWith(7, 1, "conn-x", "running");
    expect(remoteGraphApi.graphRunAbort).toHaveBeenCalledWith(55, "conn-x");

    remoteGraphApi.graphRuns.mockResolvedValue({ total: 0, items: [] });
    await expect(GraphApi.cancelTestRun(7)).rejects.toThrowError(
      "GRAPH_NOT_RUNNING",
    );
  });

  it("webhookEnable：远端相对 url 拼连接 baseUrl", async () => {
    remoteGraphApi.webhookEnable.mockResolvedValue({
      enabled: true,
      url: "/webhook/abc",
    });
    serverApi.listConnections.mockResolvedValue({
      connections: [
        { id: "conn-x", baseUrl: "http://127.0.0.1:3001/", name: "pg" },
      ],
    });
    const url = await GraphApi.webhookEnable(7, { statusCode: 201 });
    expect(url).toBe("http://127.0.0.1:3001/webhook/abc");
  });
});

describe("编排页深水功能远程门控", () => {
  beforeEach(switchRemote);

  it("polishPrompt/testNode/export/import/pickBinaryFile：远程态 throw 且不落本地通道", async () => {
    await expect(GraphApi.polishPrompt(1, "p")).rejects.toThrowError(
      /远程主机暂不支持/,
    );
    await expect(
      GraphApi.testNode({}, {}, {}, 1),
    ).rejects.toThrowError(/远程主机/);
    await expect(GraphApi.exportWorkflow({ name: "x", graphJson: "{}" })).rejects.toThrowError(
      /远程主机/,
    );
    await expect(GraphApi.importWorkflow()).rejects.toThrowError(/远程主机/);
    await expect(GraphApi.pickBinaryFile()).rejects.toThrowError(/远程主机/);
    expect(invoke).not.toHaveBeenCalled();
  });
});

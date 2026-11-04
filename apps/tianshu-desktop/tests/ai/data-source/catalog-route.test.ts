// @vitest-environment jsdom
// 配置清单域主机路由化（HD-T3，spec §2.2/2.3）：
// - 本地主机：ModelApi.listAll/test、ProviderApi.list、AssistantApi.list
//   invoke 原通道参数逐字
// - 远程主机：providerBundle/assistantList 通道 + 形状转换（RemoteModel/
//   RemoteProvider/远程专家行 → UI 本地类型；type 收窄、null→undefined、
//   远程不适用字段缺省）
// mock @/lib/ipc 与 server.api（适配器依赖 requestRemote）
import { describe, expect, it, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@/lib/ipc", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  on: () => () => {},
}));

const serverApi = vi.hoisted(() => ({
  providerBundle: vi.fn(),
  providerTest: vi.fn(),
  providerSave: vi.fn(),
  providerDelete: vi.fn(),
  providerFetchModels: vi.fn(),
  assistantList: vi.fn(),
  skillsQuery: vi.fn(),
  skillsRead: vi.fn(),
  skillsSetEnabled: vi.fn(),
  workspaceList: vi.fn(),
  sessionCreate: vi.fn(),
}));
vi.mock("../../../src-react/domains/ai/server/api/server.api", () => ({
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
} from "../../../src-react/domains/ai/data-source/host.store";
import ModelApi from "../../../src-react/domains/ai/api/model.api";
import ProviderApi from "../../../src-react/domains/ai/api/provider.api";
import AssistantApi from "../../../src-react/domains/ai/api/assistant.api";
import SkillApi from "../../../src-react/domains/ai/skills/api/skill.api";
import WorkspaceApi from "../../../src-react/domains/ai/api/workspace.api";
import SessionApi from "../../../src-react/domains/ai/api/session.api";

beforeEach(() => {
  vi.clearAllMocks();
  useHostStore.setState({
    activeHost: { kind: "local" },
    caps: LOCAL_HOST_CAPS,
  });
});

describe("配置清单域本地主机（零行为变化）", () => {
  it("ModelApi/ProviderApi/AssistantApi：invoke 原通道参数逐字", async () => {
    invoke.mockResolvedValue([]);
    await ModelApi.listAll();
    expect(invoke).toHaveBeenCalledWith("model:listAll");
    await ProviderApi.list();
    expect(invoke).toHaveBeenCalledWith("provider:list");
    await AssistantApi.list();
    expect(invoke).toHaveBeenCalledWith("assistant:list");

    invoke.mockResolvedValue({ success: true, message: "ok" });
    await ModelApi.test(3);
    expect(invoke).toHaveBeenCalledWith("model:test", 3);
    expect(serverApi.providerBundle).not.toHaveBeenCalled();
  });
});

describe("配置清单域远程主机（适配器映射）", () => {
  const bundle = {
    providers: [
      {
        id: 2,
        name: "远端服务",
        type: "openai-compatible",
        baseUrl: "https://x.example",
        apiKey: "REDACTED_SECRET",
        enabled: true,
      },
    ],
    models: [
      {
        id: 1,
        providerId: 2,
        modelId: "gpt-x",
        name: null,
        type: "llm",
        enabled: true,
        temperature: 0.5,
      },
      {
        id: 5,
        providerId: 2,
        modelId: "vec",
        type: "embedding",
        enabled: false,
      },
      { id: 6, providerId: 2, modelId: "未知型", type: "video", enabled: true },
    ],
  };

  it("ModelApi.listAll：bundle.models 形状转换（type 收窄/null→undefined/时间缺省）", async () => {
    useHostStore.getState().switchHost({ kind: "remote", connId: "c1" });
    serverApi.providerBundle.mockResolvedValue(bundle);

    const models = await ModelApi.listAll();
    expect(serverApi.providerBundle).toHaveBeenCalledWith("c1");
    expect(models).toHaveLength(3);
    expect(models[0]).toMatchObject({
      id: 1,
      providerId: 2,
      modelId: "gpt-x",
      type: "llm",
      enabled: true,
      temperature: 0.5,
      createdAt: "",
    });
    expect(models[0].name).toBeUndefined();
    // 非法 type 收窄 llm（远程新类型不炸前端枚举面）
    expect(models[2].type).toBe("llm");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("ProviderApi.list：bundle.providers 形状转换（脱敏密钥直传/时间缺省）", async () => {
    useHostStore.getState().switchHost({ kind: "remote", connId: "c1" });
    serverApi.providerBundle.mockResolvedValue(bundle);

    const providers = await ProviderApi.list();
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      id: 2,
      name: "远端服务",
      type: "openai-compatible",
      baseUrl: "https://x.example",
      apiKey: "REDACTED_SECRET",
      enabled: true,
      createdAt: "",
    });
  });

  it("ModelApi.test：bundle 查 providerId → providerTest 结果转换", async () => {
    useHostStore.getState().switchHost({ kind: "remote", connId: "c1" });
    serverApi.providerBundle.mockResolvedValue(bundle);
    serverApi.providerTest.mockResolvedValue({ ok: true, message: "连通" });

    await expect(ModelApi.test(1)).resolves.toEqual({
      success: true,
      message: "连通",
    });
    expect(serverApi.providerTest).toHaveBeenCalledWith(2, "c1");

    serverApi.providerTest.mockResolvedValue({ ok: false, message: "连不上" });
    await expect(ModelApi.test(1)).resolves.toEqual({
      success: false,
      message: "连不上",
    });
  });

  it("ModelApi.test：bundle 无该模型行（缓存过期/已删）如实抛错", async () => {
    useHostStore.getState().switchHost({ kind: "remote", connId: "c1" });
    serverApi.providerBundle.mockResolvedValue(bundle);
    await expect(ModelApi.test(999)).rejects.toThrow();
  });

  it("AssistantApi.list：远程专家行形状转换（builtin=false/缺省字段）", async () => {
    useHostStore.getState().switchHost({ kind: "remote", connId: "c1" });
    serverApi.assistantList.mockResolvedValue([
      {
        id: 3,
        name: "翻译",
        description: "中英互译",
        icon: "🌐",
        quickPrompts: ["译成英文"],
      },
    ]);

    const list = await AssistantApi.list();
    expect(serverApi.assistantList).toHaveBeenCalledWith("c1");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: 3,
      name: "翻译",
      description: "中英互译",
      icon: "🌐",
      quickPrompts: ["译成英文"],
      builtin: false,
      systemPrompt: "",
      createdAt: "",
    });
  });
});

describe("skill 域主机路由化（HD-P2b）", () => {
  it("本地：list/readSkill/setEnabled invoke 原通道参数逐字", async () => {
    invoke.mockResolvedValue([]);
    await SkillApi.list();
    expect(invoke).toHaveBeenCalledWith("skill:list");
    invoke.mockResolvedValue({ content: "正文" });
    await SkillApi.readSkill("翻译");
    expect(invoke).toHaveBeenCalledWith("skill:readSkill", { name: "翻译" });
    invoke.mockResolvedValue(null);
    await SkillApi.setEnabled("翻译", false);
    expect(invoke).toHaveBeenCalledWith("skill:setEnabled", {
      name: "翻译",
      enabled: false,
    });
    expect(serverApi.skillsQuery).not.toHaveBeenCalled();
  });

  it("远程：list → skillsQuery 形状转换（enabled 缺省 true/id 恒 0——消费面按 name 索引）", async () => {
    useHostStore.getState().switchHost({ kind: "remote", connId: "c1" });
    serverApi.skillsQuery.mockResolvedValue([
      { name: "翻译", description: "中英互译", enabled: true },
      { name: "未启停上报的技能" },
    ]);

    const skills = await SkillApi.list();
    expect(serverApi.skillsQuery).toHaveBeenCalledWith("c1");
    expect(skills).toHaveLength(2);
    expect(skills[0]).toMatchObject({
      name: "翻译",
      description: "中英互译",
      enabled: true,
    });
    expect(skills[0].id).toBe(0);
    // enabled 缺省 true（远端未上报视作启用——联想面不丢技能）
    expect(skills[1].enabled).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("远程：readSkill → skillsRead；setEnabled → skillsSetEnabled", async () => {
    useHostStore.getState().switchHost({ kind: "remote", connId: "c2" });
    serverApi.skillsRead.mockResolvedValue({ content: "远端正文" });
    await expect(SkillApi.readSkill("翻译")).resolves.toEqual({
      content: "远端正文",
    });
    expect(serverApi.skillsRead).toHaveBeenCalledWith("翻译", "c2");

    serverApi.skillsSetEnabled.mockResolvedValue(undefined);
    await SkillApi.setEnabled("翻译", false);
    expect(serverApi.skillsSetEnabled).toHaveBeenCalledWith(
      "翻译",
      false,
      "c2",
    );
  });
});

describe("workspace 域主机路由化（HD-A2：侧栏远端树）", () => {
  it("本地：list invoke 原通道参数逐字；sessionCreate 走原通道", async () => {
    invoke.mockResolvedValue([]);
    await WorkspaceApi.list();
    expect(invoke).toHaveBeenCalledWith("workspace:list");

    invoke.mockResolvedValue(undefined);
    await SessionApi.create({ workspaceId: 5 });
    expect(invoke).toHaveBeenCalledWith("session:create", { workspaceId: 5 });
    expect(serverApi.workspaceList).not.toHaveBeenCalled();
  });

  it("远程：list → workspaceList 形状转换（概要四字段/null→undefined）", async () => {
    useHostStore.getState().switchHost({ kind: "remote", connId: "c1" });
    serverApi.workspaceList.mockResolvedValue([
      {
        id: 3,
        name: "远端空间",
        directoryPath: "/remote/ws",
        defaultModelId: 7,
      },
      { id: 4, name: "无目录空间" },
    ]);

    const spaces = await WorkspaceApi.list();
    expect(serverApi.workspaceList).toHaveBeenCalledWith("c1");
    expect(spaces).toHaveLength(2);
    expect(spaces[0]).toMatchObject({
      id: 3,
      name: "远端空间",
      directoryPath: "/remote/ws",
      defaultModelId: 7,
      createdAt: "",
    });
    // null/缺省字段归 undefined（UI 既有缺省分支）
    expect(spaces[1].directoryPath).toBeUndefined();
    expect(spaces[1].defaultModelId).toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("远程新建会话：sessionCreate 携 workspaceId（远端空间内建）", async () => {
    useHostStore.getState().switchHost({ kind: "remote", connId: "c1" });
    serverApi.sessionCreate.mockResolvedValue({
      id: 21,
      title: "t",
      updatedAt: "",
    });
    await SessionApi.create({ workspaceId: 3 });
    expect(serverApi.sessionCreate).toHaveBeenCalledWith(
      { workspaceId: 3 },
      "c1",
    );
  });
});

describe("provider/model 写面主机路由化（HD-P3a：单 UI 模型页远程可编辑）", () => {
  it("本地：create/update/delete/listRemote invoke 原通道参数逐字", async () => {
    invoke.mockResolvedValue({ id: 1, name: "p" });
    await ProviderApi.create({
      name: "p",
      type: "openai-compatible",
      baseUrl: "https://x",
    });
    expect(invoke).toHaveBeenCalledWith("provider:create", {
      name: "p",
      type: "openai-compatible",
      baseUrl: "https://x",
    });
    await ProviderApi.update({ id: 1, name: "改名" });
    expect(invoke).toHaveBeenLastCalledWith("provider:update", {
      id: 1,
      name: "改名",
    });
    invoke.mockResolvedValue(undefined);
    await ProviderApi.delete(1);
    expect(invoke).toHaveBeenLastCalledWith("provider:delete", 1);
    await ModelApi.delete(5);
    expect(invoke).toHaveBeenLastCalledWith("model:delete", 5);
    invoke.mockResolvedValue({ success: true, message: "", models: [] });
    await ModelApi.listRemote(2);
    expect(invoke).toHaveBeenLastCalledWith("model:listRemote", 2);
    expect(serverApi.providerSave).not.toHaveBeenCalled();
  });

  it("远程：provider create/update → providerSave upsert（create 经 bundle diff 取新行）", async () => {
    useHostStore.getState().switchHost({ kind: "remote", connId: "c1" });
    serverApi.providerBundle.mockResolvedValueOnce({
      providers: [
        {
          id: 1,
          name: "旧",
          type: "openai-compatible",
          baseUrl: "u",
          apiKey: null,
          enabled: true,
        },
      ],
      models: [],
    });
    const savedBundle = {
      providers: [
        {
          id: 1,
          name: "旧",
          type: "openai-compatible",
          baseUrl: "u",
          apiKey: null,
          enabled: true,
        },
        {
          id: 9,
          name: "新服务商",
          type: "anthropic",
          baseUrl: "https://a",
          apiKey: "REDACTED_SECRET",
          enabled: true,
        },
      ],
      models: [],
    };
    serverApi.providerSave.mockResolvedValue(savedBundle);

    const created = await ProviderApi.create({
      name: "新服务商",
      type: "anthropic",
      baseUrl: "https://a",
    });
    // upsert 数组语义（不带 id 新建）；返回经 save 后 bundle diff 的新行
    expect(serverApi.providerSave).toHaveBeenCalledWith(
      {
        providers: [
          { name: "新服务商", type: "anthropic", baseUrl: "https://a" },
        ],
      },
      "c1",
    );
    expect(created).toMatchObject({ id: 9, name: "新服务商" });
    expect(created.apiKey).toBe("REDACTED_SECRET");

    // 更新：无头端 save DTO 必填 type/baseUrl——bundle 现值补全差量为全量
    // （undefined 键不覆盖；apiKey 基线不含掩码=不改）
    serverApi.providerBundle.mockResolvedValueOnce(savedBundle);
    await ProviderApi.update({ id: 9, name: "改名" });
    expect(serverApi.providerSave).toHaveBeenLastCalledWith(
      {
        providers: [
          {
            id: 9,
            name: "改名",
            type: "anthropic",
            baseUrl: "https://a",
            enabled: true,
          },
        ],
      },
      "c1",
    );
  });

  it("远程：delete → providerDelete（providerIds/modelIds 单删）", async () => {
    useHostStore.getState().switchHost({ kind: "remote", connId: "c1" });
    serverApi.providerDelete.mockResolvedValue({ providers: [], models: [] });
    await ProviderApi.delete(3);
    expect(serverApi.providerDelete).toHaveBeenCalledWith(
      { providerIds: [3] },
      "c1",
    );
    await ModelApi.delete(7);
    expect(serverApi.providerDelete).toHaveBeenLastCalledWith(
      { modelIds: [7] },
      "c1",
    );
  });

  it("远程：model create/update → providerSave models upsert；listRemote → providerFetchModels", async () => {
    useHostStore.getState().switchHost({ kind: "remote", connId: "c1" });
    serverApi.providerBundle.mockResolvedValueOnce({
      providers: [],
      models: [
        {
          id: 1,
          providerId: 2,
          modelId: "old",
          name: null,
          type: "llm",
          enabled: true,
        },
      ],
    });
    serverApi.providerSave.mockResolvedValue({
      providers: [],
      models: [
        {
          id: 1,
          providerId: 2,
          modelId: "old",
          name: null,
          type: "llm",
          enabled: true,
        },
        {
          id: 11,
          providerId: 2,
          modelId: "qwen-x",
          name: null,
          type: "llm",
          enabled: true,
        },
      ],
    });
    const created = await ModelApi.create({
      providerId: 2,
      modelId: "qwen-x",
      type: "llm",
    });
    expect(serverApi.providerSave).toHaveBeenCalledWith(
      { models: [{ providerId: 2, modelId: "qwen-x", type: "llm" }] },
      "c1",
    );
    expect(created).toMatchObject({ id: 11, modelId: "qwen-x" });

    // 更新：同 provider 款 bundle 现值补全（providerId/modelId/type 必填）
    serverApi.providerBundle.mockResolvedValueOnce({
      providers: [],
      models: [
        {
          id: 11,
          providerId: 2,
          modelId: "qwen-x",
          name: null,
          type: "llm",
          enabled: true,
        },
      ],
    });
    await ModelApi.update({ id: 11, modelId: "qwen-2" });
    expect(serverApi.providerSave).toHaveBeenLastCalledWith(
      {
        models: [
          {
            id: 11,
            providerId: 2,
            modelId: "qwen-2",
            type: "llm",
            enabled: true,
          },
        ],
      },
      "c1",
    );

    serverApi.providerFetchModels.mockResolvedValue({
      success: true,
      message: "",
      models: [{ modelId: "up-1", name: "上游模型" }],
    });
    const remote = await ModelApi.listRemote(2);
    expect(serverApi.providerFetchModels).toHaveBeenCalledWith(2, "c1");
    expect(remote).toMatchObject({
      success: true,
      models: [{ modelId: "up-1" }],
    });
  });
});

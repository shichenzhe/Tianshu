// RC-T3 @tianshu/core 核心逻辑包接入测试：chat 纯函数实现物理搬入包内，
// mirror 原位改 re-export。钉住三件事（对齐 protocol-package.test.ts 先例，
// 断言全部走运行时，规避 tests/ 不在 tsconfig include 的无牙问题）：
// 1. alias 解析——vitest resolve.alias 未登记 @tianshu/core 时首行 import
//    即失败；
// 2. 收编非复制——原位 re-export 与包导出为同一运行时引用（函数/常量
//    toBe 引用相等）；
// 3. 搬迁行为不变——parseBlocks 容错/withTimeBlock 注入/mergeParams 覆盖
//    语义抽查（既有用例 tests/ai/blocks.test.ts 等照跑兜底全量）。
// GA-T2 增补：编排纯逻辑 + graph/schedule zod schema 全量入包——四件
// （graph-compiler/graph-prompt/schedule/graph.schema）+ 闭包随行件
// schedule.schema（schedule.ts 的 ScheduleConfig 类型唯一源，同 graph.schema
// 先例原位 re-export）。identity + 行为 + 类型 witness 三牙同构。
import { describe, expect, it } from "vitest";
import {
  blocksToModelMessages,
  IMAGE_TOKEN_ESTIMATE,
  classifyError,
  estimateTokens,
  mergeParams,
  parseBlocks,
  serializeBlocks,
  withTimeBlock,
  GRAPH_RECURSION_LIMIT,
  GraphTemplateError,
  buildEdgePlan,
  compileStateGraph,
  computeNextRun,
  graphJsonSchema,
  intervalMinutes,
  renderNodePrompt,
  scheduleSchema,
  validateGraph,
  type GraphJson,
  type ScheduleConfig,
} from "@tianshu/core";
import {
  blocksToModelMessages as blocksToModelMessagesOld,
  parseBlocks as parseBlocksOld,
  serializeBlocks as serializeBlocksOld,
} from "../../electron/domains/ai/chat/blocks";
import { estimateTokens as estimateTokensOld } from "../../electron/domains/ai/chat/history-truncate";
import { classifyError as classifyErrorOld } from "../../electron/domains/ai/chat/error-classify";
import { mergeParams as mergeParamsOld } from "../../electron/domains/ai/chat/param-merge";
import { withTimeBlock as withTimeBlockOld } from "../../electron/domains/ai/chat/time-context";
import {
  buildEdgePlan as buildEdgePlanOld,
  compileStateGraph as compileStateGraphOld,
  GRAPH_RECURSION_LIMIT as GRAPH_RECURSION_LIMITOld,
} from "../../electron/domains/ai/orchestration/graph-compiler";
import {
  GraphTemplateError as GraphTemplateErrorOld,
  renderNodePrompt as renderNodePromptOld,
} from "../../electron/domains/ai/orchestration/graph-prompt";
import { computeNextRun as computeNextRunOld } from "../../electron/domains/ai/automation/schedule";
import {
  graphJsonSchema as graphJsonSchemaOld,
  validateGraph as validateGraphOld,
  type GraphJson as GraphJsonSchemaOld,
} from "../../src-react/domains/ai/orchestration/api/graph.schema";
import {
  intervalMinutes as intervalMinutesOld,
  scheduleSchema as scheduleSchemaOld,
  type ScheduleConfig as ScheduleConfigOld,
} from "../../src-react/domains/ai/automation/api/schedule.schema";
import {
  PERSONALIZATION_KEYS,
  defaultPersonalization,
  buildPersonalizedSystem,
  STYLE_PROMPTS,
  type PersonalizationConfig,
} from "@tianshu/core";
import {
  buildPersonalizedSystem as buildPersonalizedSystemOld,
  STYLE_PROMPTS as STYLE_PROMPTSOld,
} from "../../electron/domains/ai/personalization/personalization.prompt";
import {
  PERSONALIZATION_KEYS as PERSONALIZATION_KEYSOld,
  defaultPersonalization as defaultPersonalizationOld,
  type PersonalizationConfig as PersonalizationConfigOld,
} from "../../electron/domains/ai/personalization/personalization.config";

describe("@tianshu/core 核心逻辑包", () => {
  it("原位 re-export 与包导出同一运行时引用（收编非复制）", () => {
    expect(parseBlocksOld).toBe(parseBlocks);
    expect(serializeBlocksOld).toBe(serializeBlocks);
    expect(blocksToModelMessagesOld).toBe(blocksToModelMessages);
    expect(estimateTokensOld).toBe(estimateTokens);
    expect(classifyErrorOld).toBe(classifyError);
    expect(mergeParamsOld).toBe(mergeParams);
    expect(withTimeBlockOld).toBe(withTimeBlock);
  });

  it("搬迁行为不变：parseBlocks 容错 + 序列化 roundtrip", () => {
    expect(parseBlocks('[{"type":"text","text":"hi"}]')).toEqual([
      { type: "text", text: "hi" },
    ]);
    expect(parseBlocks("not-json")).toEqual([]);
    expect(parseBlocks('[{"type":"text","text":1}]')).toEqual([]);
    const blocks = [{ type: "text", text: "a" }] as const;
    expect(parseBlocks(serializeBlocks([...blocks]))).toEqual([
      { type: "text", text: "a" },
    ]);
  });

  it("搬迁行为不变：常量/分类/参数合并/时间注入抽查", () => {
    expect(IMAGE_TOKEN_ESTIMATE).toBe(1000);
    expect(estimateTokens("abcd")).toBe(2);
    expect(classifyError({ status: 429 })).toBe("RATE_LIMITED");
    expect(
      mergeParams([
        { temperature: 0.1 },
        undefined,
        { temperature: 0.7, maxTokens: 128 },
      ]),
    ).toEqual({ temperature: 0.7, maxTokens: 128 });
    const now = new Date("2026-10-17T09:30:00");
    expect(parseBlocks(withTimeBlock("[]", now)).length).toBe(1);
  });
});

describe("@tianshu/core GA-T2：编排纯逻辑+graph/schedule schema 入包", () => {
  it("原位 re-export 与包导出同一运行时引用（四件+随行件，收编非复制）", () => {
    expect(compileStateGraphOld).toBe(compileStateGraph);
    expect(buildEdgePlanOld).toBe(buildEdgePlan);
    expect(GRAPH_RECURSION_LIMITOld).toBe(GRAPH_RECURSION_LIMIT);
    expect(renderNodePromptOld).toBe(renderNodePrompt);
    expect(GraphTemplateErrorOld).toBe(GraphTemplateError);
    expect(computeNextRunOld).toBe(computeNextRun);
    expect(validateGraphOld).toBe(validateGraph);
    expect(graphJsonSchemaOld).toBe(graphJsonSchema);
    expect(scheduleSchemaOld).toBe(scheduleSchema);
    expect(intervalMinutesOld).toBe(intervalMinutes);
  });

  it("老路径 re-export 与包类型同一（GraphJson/ScheduleConfig 双向可赋值 witness）", () => {
    const graphFromOld: GraphJson = null as unknown as GraphJsonSchemaOld;
    const graphToOld: GraphJsonSchemaOld = null as unknown as GraphJson;
    const scheduleFromOld: ScheduleConfig =
      null as unknown as ScheduleConfigOld;
    const scheduleToOld: ScheduleConfigOld = null as unknown as ScheduleConfig;
    expect([
      graphFromOld,
      graphToOld,
      scheduleFromOld,
      scheduleToOld,
    ]).toHaveLength(4);
  });

  it("renderNodePrompt 包路径行为不变：模板替换 + 缺引用抛 GraphTemplateError", () => {
    const now = new Date("2026-10-17T09:30:00");
    expect(
      renderNodePrompt("{{input.q}} at {{date}} {{weekday}} {{time}}", {
        inputs: { q: "hi" },
        nodes: {},
        now,
      }),
    ).toBe("hi at 2026-10-17 六 09:30");
    expect(
      renderNodePrompt("{{nodes.a-1.output}}", {
        inputs: {},
        nodes: { "a-1": { output: "done" } },
        now,
      }),
    ).toBe("done");
    expect(() =>
      renderNodePrompt("{{nodes.a-1.errorOutput}}", {
        inputs: {},
        nodes: { "a-1": { output: "done" } },
        now,
      }),
    ).toThrow(GraphTemplateError);
  });

  it("computeNextRun 包路径行为不变：once 过期 null / interval 相位推进 / monthly 月末跳月", () => {
    expect(
      computeNextRun(
        { mode: "periodic", kind: "once", runAt: "2026-09-01T00:00:00Z" },
        new Date("2026-10-17T00:00:00Z"),
      ),
    ).toBeNull();
    expect(
      computeNextRun(
        { mode: "interval", value: 30, unit: "minute" },
        new Date("2026-10-17T11:00:00"),
        new Date("2026-10-17T08:00:00"),
      ),
    ).toEqual(new Date("2026-10-17T11:30:00"));
    // 9 月无 31 日 → 跳到 10 月 31 日
    expect(
      computeNextRun(
        {
          mode: "periodic",
          kind: "monthly",
          dayOfMonth: 31,
          time: "08:00",
        },
        new Date("2026-09-01T00:00:00"),
      ),
    ).toEqual(new Date("2026-10-31T08:00:00"));
  });

  it("validateGraph/graphJsonSchema 包路径运行时完好（最小合法图 ok:true）", () => {
    const ok = validateGraph({
      version: 1,
      inputSchema: {},
      nodes: [{ id: "n-1", name: "N", kind: "llm", modelId: 1, prompt: "p" }],
      edges: [],
    });
    expect(ok.ok).toBe(true);
    expect(graphJsonSchema.shape.version.value).toBe(1);
  });
});

describe("@tianshu/core PL-1：personalization prompt/纯常量段入包", () => {
  it("原位 re-export 与包导出同一运行时引用（prompt 全件 + config 常量段，收编非复制）", () => {
    expect(buildPersonalizedSystemOld).toBe(buildPersonalizedSystem);
    expect(STYLE_PROMPTSOld).toBe(STYLE_PROMPTS);
    expect(PERSONALIZATION_KEYSOld).toBe(PERSONALIZATION_KEYS);
    expect(defaultPersonalizationOld).toBe(defaultPersonalization);
  });

  it("老路径 re-export 与包类型同一（PersonalizationConfig 双向可赋值 witness）", () => {
    const fromOld: PersonalizationConfig =
      null as unknown as PersonalizationConfigOld;
    const toOld: PersonalizationConfigOld =
      null as unknown as PersonalizationConfig;
    expect([fromOld, toOld]).toHaveLength(2);
  });

  it("buildPersonalizedSystem 包路径行为不变：全默认逐字节还原 + persona 前置 + Profile 段注入", () => {
    const BASE = "你是专家助手。";
    expect(buildPersonalizedSystem(defaultPersonalization(), BASE)).toBe(BASE);
    expect(
      buildPersonalizedSystem(defaultPersonalization(), undefined),
    ).toBeUndefined();
    expect(
      buildPersonalizedSystem(
        { ...defaultPersonalization(), persona: "P" },
        BASE,
      ),
    ).toBe(`P\n\n${BASE}`);
    const withProfile = buildPersonalizedSystem(
      { ...defaultPersonalization(), memoryProfile: "## 画像" },
      BASE,
    );
    expect(withProfile).toBe(
      `${BASE}\n\n【用户画像记忆】\n以下是系统从对话中提炼的用户画像，请在对话中参考：\n## 画像`,
    );
  });
});

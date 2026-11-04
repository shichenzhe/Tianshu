/**
 * consumeAgentStream 映射层单测（统一 LLM 栈 T3-2，spec §4.3）
 *
 * 全部行为级断言（tests/ 不在 tsconfig include，类型编译断言在本仓库无效）：
 * 合成 StreamEvent 纯对象数组驱动，不依赖真模型/真 langgraph。
 *
 * 载荷形状按本地安装版 dist 核对（@langchain/core 1.2.17 + langgraph 1.5.0）：
 * - on_chat_model_stream：data.chunk = AIMessageChunk（content: string |
 *   ContentBlock[]，reasoning 走 additional_kwargs.reasoning_content，
 *   usage_metadata{input_tokens, output_tokens}）
 * - on_tool_start：data.input = 工具 args 对象（langgraph ToolNode 经 ToolCall
 *   调用，core Tool.invoke 解包 input.args 后才记 trace 输入）
 * - on_tool_end：data.output = ToolMessage 实例（core _formatToolOutput 包装，
 *   真实载荷在 .content）
 * - on_tool_error：工具抛错时 core tracer 实发事件，data.error 为 string
 *   （计划假想的 on_tool_end(Error 对象) 双形态一并支持）
 */
import { describe, expect, it } from "vitest";
import { AIMessageChunk, ToolMessage } from "@langchain/core/messages";
import {
  consumeAgentStream,
  type EmitterCallbacks,
} from "../../electron/domains/ai/chat/agent-chunk-emitter";

const asyncOf = <T>(xs: T[]) =>
  (async function* () {
    for (const x of xs) yield x;
  })();

// ---------- 夹具：回调记录器 + 合成事件 ----------

/** 每个回调记一行 `类型|载荷`，顺序敏感（golden 序列即顺序契约） */
function makeRecorder(): EmitterCallbacks & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    onTextDelta: (text) => log.push(`text|${text}`),
    onReasoningDelta: (text) => log.push(`reasoning|${text}`),
    onToolCall: (c) =>
      log.push(`call|${c.toolCallId}|${c.toolName}|${JSON.stringify(c.args)}`),
    onToolResult: (c) => log.push(`result|${c.toolCallId}|${c.output}`),
    onToolError: (c) => log.push(`tool-error|${c.toolCallId}|${c.error}`),
    onFinish: (u) =>
      log.push(`finish|${u === undefined ? "none" : `${u.input}/${u.output}`}`),
    onError: (e) =>
      log.push(`error|${e instanceof Error ? e.message : String(e)}`),
  };
}

interface SyntheticEvent {
  event: string;
  name: string;
  run_id: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

const streamChunk = (runId: string, chunk: unknown): SyntheticEvent => ({
  event: "on_chat_model_stream",
  name: "model",
  run_id: runId,
  tags: [],
  metadata: {},
  data: { chunk },
});

const modelEnd = (runId: string, output: unknown): SyntheticEvent => ({
  event: "on_chat_model_end",
  name: "model",
  run_id: runId,
  tags: [],
  metadata: {},
  data: { output },
});

const toolStart = (
  runId: string,
  name: string,
  input: unknown,
): SyntheticEvent => ({
  event: "on_tool_start",
  name,
  run_id: runId,
  tags: [],
  metadata: {},
  data: { input },
});

const toolEnd = (runId: string, output: unknown): SyntheticEvent => ({
  event: "on_tool_end",
  name: "echo",
  run_id: runId,
  tags: [],
  metadata: {},
  data: { output },
});

const toolErrorEvent = (runId: string, error: string): SyntheticEvent => ({
  event: "on_tool_error",
  name: "echo",
  run_id: runId,
  tags: [],
  metadata: {},
  data: { input: {}, error },
});

const noise = (event: string): SyntheticEvent => ({
  event,
  name: "agent",
  run_id: "n1",
  tags: [],
  metadata: {},
  data: {},
});

describe("consumeAgentStream（StreamEvent → onChunk 映射）", () => {
  it("A 文本增量逐段透传：字符串 content 每事件一段，真实 AIMessageChunk 实例同样驱动，无关事件静默跳过", async () => {
    const rec = makeRecorder();

    await consumeAgentStream(
      asyncOf<SyntheticEvent>([
        noise("on_chain_start"),
        streamChunk("m1", new AIMessageChunk({ content: "你好" })),
        streamChunk("m1", { content: "！" }),
        noise("on_chain_end"),
      ]),
      rec,
      () => false,
    );

    expect(rec.log).toEqual(["text|你好", "text|！", "finish|none"]);
  });

  it("A2 content 为 content block 数组时拼接 text 块（非 text 块跳过）", async () => {
    const rec = makeRecorder();

    await consumeAgentStream(
      asyncOf<SyntheticEvent>([
        streamChunk("m1", {
          content: [
            { type: "text", text: "看" },
            { type: "image_url", image_url: "data:..." },
            { type: "text", text: "图" },
          ],
        }),
      ]),
      rec,
      () => false,
    );

    expect(rec.log).toEqual(["text|看", "text|图", "finish|none"]);
  });

  it("B reasoning_content → onReasoningDelta；同 chunk 先 reasoning 后 text（golden A 序）", async () => {
    const rec = makeRecorder();

    await consumeAgentStream(
      asyncOf<SyntheticEvent>([
        streamChunk("m1", {
          content: "你好",
          additional_kwargs: { reasoning_content: "想一想" },
        }),
      ]),
      rec,
      () => false,
    );

    expect(rec.log).toEqual(["reasoning|想一想", "text|你好", "finish|none"]);
  });

  it("C 工具往返：on_tool_start(含 args) → onToolCall；on_tool_end 解包 ToolMessage 取 content → onToolResult", async () => {
    const rec = makeRecorder();

    await consumeAgentStream(
      asyncOf<SyntheticEvent>([
        toolStart("r-tool-1", "echo", { text: "ping" }),
        toolEnd(
          "r-tool-1",
          new ToolMessage({
            content: "echo: ping",
            tool_call_id: "call-1",
            name: "echo",
          }),
        ),
      ]),
      rec,
      () => false,
    );

    expect(rec.log).toEqual([
      'call|r-tool-1|echo|{"text":"ping"}',
      "result|r-tool-1|echo: ping",
      "finish|none",
    ]);
  });

  it("C2 on_tool_end 裸字符串/对象输出归一：string 直取，其余 JSON.stringify 截断 500 字符", async () => {
    const rec = makeRecorder();
    const big: Record<string, string> = {};
    for (let i = 0; i < 60; i += 1) big[`key${i}`] = "x".repeat(20);

    await consumeAgentStream(
      asyncOf<SyntheticEvent>([
        toolEnd("r1", "纯文本输出"),
        toolEnd("r2", big),
        toolEnd("r3", undefined),
      ]),
      rec,
      () => false,
    );

    expect(rec.log).toEqual([
      "result|r1|纯文本输出",
      `result|r2|${JSON.stringify(big).slice(0, 500)}`,
      "result|r3|",
      "finish|none",
    ]);
    expect(JSON.stringify(big).length).toBeGreaterThan(500);
  });

  it("C3 工具失败双形态：on_tool_end(Error)（计划假想）与 on_tool_error(string)（core tracer 实发）都归一 onToolError", async () => {
    const rec = makeRecorder();

    await consumeAgentStream(
      asyncOf<SyntheticEvent>([
        toolEnd("r1", new Error("boom")),
        toolErrorEvent("r2", "connection lost"),
      ]),
      rec,
      () => false,
    );

    expect(rec.log).toEqual([
      "tool-error|r1|boom",
      "tool-error|r2|connection lost",
      "finish|none",
    ]);
  });

  it("C4 挂起项 (name, args) 匹配失败 → else 分支按 run_id 重复发射 onToolCall（dist 细节依赖预警：core Tool.invoke 记 trace 输入的是 zod 校验前原 args，langgraph 升级改记校验后 args 即失配——本测试变红即提示该失配已现实化，需复核关联策略）", async () => {
    const rec = makeRecorder();

    await consumeAgentStream(
      asyncOf<SyntheticEvent>([
        modelEnd("m1", {
          content: "",
          tool_calls: [{ id: "call-9", name: "echo", args: { query: "原样" } }],
        }),
        // args 值失配（键序不同同理——stableJson 按序列化字符串比对）
        toolStart("r-tool-9", "echo", { query: "校验后" }),
      ]),
      rec,
      () => false,
    );

    // 钉死现状：模型 id 先发射，失配的 on_tool_start 再按 run_id 重复发射一次
    expect(rec.log).toEqual([
      'call|call-9|echo|{"query":"原样"}',
      'call|r-tool-9|echo|{"query":"校验后"}',
      "finish|none",
    ]);
  });

  it("C5 on_tool_end 优先载荷 ToolMessage.tool_call_id（仅限本流已发射 id）：挂起项失配时终态救援回模型 id；陌生载荷 id 不劫走终态（回退 run_id 由用例 C 钉死）", async () => {
    const rec = makeRecorder();

    await consumeAgentStream(
      asyncOf<SyntheticEvent>([
        modelEnd("m1", {
          content: "",
          tool_calls: [{ id: "call-9", name: "echo", args: { query: "原样" } }],
        }),
        toolStart("r-tool-9", "echo", { query: "校验后" }),
        // 关联映射未建立（失配），但载荷 ToolMessage 携带模型 id 且已发射
        // → 终态落回模型 id 的块，而非孤儿 run_id
        toolEnd(
          "r-tool-9",
          new ToolMessage({
            content: "echo: ok",
            tool_call_id: "call-9",
            name: "echo",
          }),
        ),
      ]),
      rec,
      () => false,
    );

    expect(rec.log).toEqual([
      'call|call-9|echo|{"query":"原样"}',
      'call|r-tool-9|echo|{"query":"校验后"}',
      "result|call-9|echo: ok",
      "finish|none",
    ]);
  });

  it("C6 stringifyOutput 防御分支：循环引用降级 String() 兜底、ToolMessage 对象/数组 content 递归归一——不炸且有字符串产出", async () => {
    const rec = makeRecorder();
    const circular: Record<string, unknown> = { name: "环" };
    circular.self = circular;

    await consumeAgentStream(
      asyncOf<SyntheticEvent>([
        // 裸循环引用载荷：JSON.stringify throw → String() 兜底
        toolEnd("r1", circular),
        // ToolMessage 循环引用 content：递归进 content 后同样降级
        toolEnd(
          "r2",
          new ToolMessage({ content: circular, tool_call_id: "c2", name: "e" }),
        ),
        // 对象 content：递归 JSON 化
        toolEnd(
          "r3",
          new ToolMessage({
            content: { rows: [1, 2] },
            tool_call_id: "c3",
            name: "e",
          }),
        ),
        // text 块数组 content：递归拼接
        toolEnd(
          "r4",
          new ToolMessage({
            content: [
              { type: "text", text: "结" },
              { type: "text", text: "果" },
            ],
            tool_call_id: "c4",
            name: "e",
          }),
        ),
        // 混合块数组 content（非全 text）：递归 JSON 化
        toolEnd(
          "r5",
          new ToolMessage({
            content: [{ type: "image_url", image_url: "data:..." }],
            tool_call_id: "c5",
            name: "e",
          }),
        ),
      ]),
      rec,
      () => false,
    );

    expect(rec.log).toEqual([
      "result|r1|[object Object]",
      "result|r2|[object Object]",
      'result|r3|{"rows":[1,2]}',
      "result|r4|结果",
      'result|r5|[{"type":"image_url","image_url":"data:..."}]',
      "finish|none",
    ]);
  });

  it("D usage 多轮累加：各轮 usage_metadata 相加入总账（对齐 totalUsage 全步累加）；无 usage → onFinish(undefined) 收尾", async () => {
    const withUsage = makeRecorder();
    await consumeAgentStream(
      asyncOf<SyntheticEvent>([
        streamChunk("m1", {
          content: "",
          usage_metadata: { input_tokens: 2, output_tokens: 7 },
        }),
        streamChunk("m2", {
          content: "终答",
          usage_metadata: { input_tokens: 5, output_tokens: 9 },
        }),
      ]),
      withUsage,
      () => false,
    );
    expect(withUsage.log).toEqual(["text|终答", "finish|7/16"]);

    const noUsage = makeRecorder();
    await consumeAgentStream(
      asyncOf<SyntheticEvent>([streamChunk("m1", { content: "hi" })]),
      noUsage,
      () => false,
    );
    expect(noUsage.log).toEqual(["text|hi", "finish|none"]);
  });

  it("D2 同一轮 stream 末 chunk 与 on_chat_model_end 各报一次 → 按 run_id 去重每轮恰计一次", async () => {
    const rec = makeRecorder();
    await consumeAgentStream(
      asyncOf<SyntheticEvent>([
        streamChunk("m1", {
          content: "",
          usage_metadata: { input_tokens: 2, output_tokens: 7 },
        }),
        modelEnd("m1", {
          content: "",
          usage_metadata: { input_tokens: 2, output_tokens: 7 },
        }),
        streamChunk("m2", {
          content: "终答",
          usage_metadata: { input_tokens: 5, output_tokens: 9 },
        }),
        modelEnd("m2", {
          content: "终答",
          usage_metadata: { input_tokens: 5, output_tokens: 9 },
        }),
      ]),
      rec,
      () => false,
    );
    // 双报不双计：两轮各计一次 = 2/7 + 5/9，而非 14/32
    expect(rec.log).toEqual(["text|终答", "finish|7/16"]);
  });

  it("D3 仅聚合上报（流式 chunk 无 usage_metadata）→ end 事件兜底入账", async () => {
    const rec = makeRecorder();
    await consumeAgentStream(
      asyncOf<SyntheticEvent>([
        streamChunk("m1", { content: "终答" }),
        modelEnd("m1", {
          content: "终答",
          usage_metadata: { input_tokens: 5, output_tokens: 9 },
        }),
      ]),
      rec,
      () => false,
    );
    expect(rec.log).toEqual(["text|终答", "finish|5/9"]);
  });

  it("D4 同轮多 chunk 上报：end 聚合为该轮权威总值覆盖流式累计（累计口径 chunk 不重复计）", async () => {
    const rec = makeRecorder();
    await consumeAgentStream(
      asyncOf<SyntheticEvent>([
        // 部分 OpenAI 兼容端点逐 chunk 附累计口径 usage：流式侧按轮累加
        // 会得到 4/10，end 聚合（concat 全值）覆盖为该轮真实终值 2/7
        streamChunk("m1", {
          content: "",
          usage_metadata: { input_tokens: 2, output_tokens: 3 },
        }),
        streamChunk("m1", {
          content: "",
          usage_metadata: { input_tokens: 2, output_tokens: 7 },
        }),
        modelEnd("m1", {
          content: "",
          usage_metadata: { input_tokens: 2, output_tokens: 7 },
        }),
      ]),
      rec,
      () => false,
    );
    expect(rec.log).toEqual(["finish|2/7"]);
  });

  it("E1 迭代抛错且未中止 → 先补 onFinish(usage) 再 onError（终审 T9a 行为变化，非回归：错误路径统一关块转发已结算 usage，此处无 usage → undefined；已产出内容保留）", async () => {
    const rec = makeRecorder();
    function* broken(): Generator<SyntheticEvent> {
      yield streamChunk("m1", { content: "部分" });
      throw new Error("stream blew up");
    }
    const eventStream = (async function* () {
      for (const ev of broken()) yield ev;
    })();

    await consumeAgentStream(eventStream, rec, () => false);

    // 语义依据（终审 T9a）：旧引擎保险丝截断等场景 finish part 带真实
    // totalUsage，错误路径丢弃 accumulator 会让监控 DB 缺 token 统计 →
    // catch 先统一关块再 onError；onFinish(undefined) 与旧引擎无 usage
    // 不产块口径一致
    expect(rec.log).toEqual([
      "text|部分",
      "finish|none",
      "error|stream blew up",
    ]);
  });

  it("E2 迭代抛错且已中止 → 静默吞掉：无 onError 无 onFinish，已生成内容保留", async () => {
    const rec = makeRecorder();
    function* aborted(): Generator<SyntheticEvent> {
      yield streamChunk("m1", { content: "部分" });
      throw new Error("aborted mid-flight");
    }
    const eventStream = (async function* () {
      for (const ev of aborted()) yield ev;
    })();

    await consumeAgentStream(eventStream, rec, () => true);

    expect(rec.log).toEqual(["text|部分"]);
  });

  it("E3 保险丝场景：抛错前流含已结算 usage 轮 → catch 先转发 finish|累计值 再 error（终审 T9a：旧引擎 stopWhen 截断 finish part 带真实 totalUsage，监控 DB 不缺 token 统计）", async () => {
    const rec = makeRecorder();
    function* fuse(): Generator<SyntheticEvent> {
      // 轮 1 完整结算：stream/end 双报按 run_id 去重恰计一次（2/7）
      yield streamChunk("m1", {
        content: "第一轮",
        usage_metadata: { input_tokens: 2, output_tokens: 7 },
      });
      yield modelEnd("m1", {
        content: "",
        usage_metadata: { input_tokens: 2, output_tokens: 7 },
      });
      // 轮 2 截断在 end 事件前（GraphRecursionError 语义）：流式侧上报
      // 余额由 catch 补调的 finish() 兜底结算（5/9）
      yield streamChunk("m2", {
        content: "",
        usage_metadata: { input_tokens: 5, output_tokens: 9 },
      });
      throw new Error("Recursion limit of 8 reached");
    }
    const eventStream = (async function* () {
      for (const ev of fuse()) yield ev;
    })();

    await consumeAgentStream(eventStream, rec, () => false);

    expect(rec.log).toEqual([
      "text|第一轮",
      "finish|7/16",
      "error|Recursion limit of 8 reached",
    ]);
  });

  it("E4 抛错且无任何 usage → catch 转发 finish|none 先于 error（统一关块口径；无 usage 不产块）", async () => {
    const rec = makeRecorder();
    // 空迭代即拒：首个 next() 直接 reject（无 yield 可走，改用拒绝式
    // AsyncIterable 避免 require-yield）
    const eventStream: AsyncIterable<SyntheticEvent> = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error("died before anything")),
      }),
    };

    await consumeAgentStream(eventStream, rec, () => false);

    expect(rec.log).toEqual(["finish|none", "error|died before anything"]);
  });
});

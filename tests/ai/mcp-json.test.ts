/**
 * mcp-json 纯函数测试：序列化（排序/双 transport/enabled 不出现）、
 * 解析（归一/transport 推断/类型校验/名称校验/行号定位）、模板合入、
 * diff 判定（canonical JSON 比较防键序误判）
 */
import { describe, expect, it } from "vitest";

import {
  mergeTemplate,
  parseMcpConfig,
  recordsToJsonText,
  syncParamsChanged,
} from "../../src-react/domains/ai/mcp/lib/mcp-json";
import type { McpServerRecord } from "../../src-react/domains/ai/api/mcp.api";

function record(partial: Partial<McpServerRecord>): McpServerRecord {
  return {
    id: 1,
    name: "demo",
    transport: "stdio",
    command: "npx",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("recordsToJsonText", () => {
  it("stdio 记录序列化为 command/args/env 原生对象形态", () => {
    const text = recordsToJsonText([
      record({
        name: "b",
        args: '["--port", "8080"]',
        env: '{"KEY":"value"}',
      }),
    ]);
    expect(JSON.parse(text)).toEqual({
      mcpServers: {
        b: { command: "npx", args: ["--port", "8080"], env: { KEY: "value" } },
      },
    });
  });

  it("http 记录序列化为 url/headers；输出按 name 字典序且不含 enabled", () => {
    const text = recordsToJsonText([
      record({
        name: "z",
        transport: "http",
        command: undefined,
        url: "https://z.dev/mcp",
      }),
      record({
        name: "a",
        transport: "http",
        command: undefined,
        url: "https://a.dev/mcp",
        headers: '{"Authorization":"Bearer t"}',
      }),
    ]);
    expect(Object.keys(JSON.parse(text).mcpServers)).toEqual(["a", "z"]);
    expect(JSON.parse(text).mcpServers.a).toEqual({
      url: "https://a.dev/mcp",
      headers: { Authorization: "Bearer t" },
    });
    expect(text).not.toContain("enabled");
  });

  it("空记录集输出空 mcpServers 骨架", () => {
    expect(recordsToJsonText([])).toBe('{\n  "mcpServers": {}\n}');
  });

  it("坏 JSON 列省略字段不抛错", () => {
    const text = recordsToJsonText([record({ name: "x", args: "{broken" })]);
    expect(JSON.parse(text).mcpServers.x).toEqual({ command: "npx" });
  });
});

describe("parseMcpConfig", () => {
  it("归一：原生对象 → JSON 字符串列 + 推断 transport", () => {
    const result = parseMcpConfig(
      '{\n  "mcpServers": {\n    "a": { "command": "npx", "args": ["-y", "p"], "env": { "K": "v" } }\n  }\n}',
    );
    expect(result.a).toEqual({
      transport: "stdio",
      command: "npx",
      args: '["-y","p"]',
      env: '{"K":"v"}',
      url: undefined,
      headers: undefined,
    });
  });

  it("JSON 字符串口径的 args/env 同样接受并原样归一", () => {
    const result = parseMcpConfig(
      '{"mcpServers":{"h":{"url":"https://h.dev","headers":"{\\"A\\":\\"b\\"}"}}}',
    );
    expect(result.h).toEqual({
      transport: "http",
      url: "https://h.dev",
      headers: '{"A":"b"}',
      command: undefined,
      args: undefined,
      env: undefined,
    });
  });

  it("非法 JSON 抛带行号的 PARSE 错误码", () => {
    try {
      parseMcpConfig('{\n  "mcpServers": {\n');
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toBe("MCP_JSON_PARSE:3");
    }
  });

  it("顶层缺 mcpServers 抛 STRUCTURE 错误码", () => {
    expect(() => parseMcpConfig("{}")).toThrow("MCP_JSON_STRUCTURE:mcpServers");
  });

  it("command 与 url 同时缺失/同时存在抛 TRANSPORT 错误码", () => {
    expect(() =>
      parseMcpConfig(
        '{"mcpServers":{"a":{"command":"npx","url":"https://a"}}}',
      ),
    ).toThrow("MCP_ENTRY_TRANSPORT:a");
    expect(() => parseMcpConfig('{"mcpServers":{"a":{}}}')).toThrow(
      "MCP_ENTRY_TRANSPORT:a",
    );
  });

  it("名称含连续下划线抛 NAME 错误码", () => {
    expect(() =>
      parseMcpConfig('{"mcpServers":{"a__b":{"command":"npx"}}}'),
    ).toThrow("MCP_NAME_INVALID:a__b");
  });

  it("args 非字符串数组 / env 非字符串值对象 抛类型错误码", () => {
    expect(() =>
      parseMcpConfig('{"mcpServers":{"a":{"command":"npx","args":["x",1]}}}'),
    ).toThrow("MCP_ARGS_INVALID:a");
    expect(() =>
      parseMcpConfig('{"mcpServers":{"a":{"command":"npx","env":{"K":1}}}}'),
    ).toThrow("MCP_ENV_INVALID:a");
    expect(() =>
      parseMcpConfig(
        '{"mcpServers":{"a":{"url":"https://a","headers":"not json"}}}',
      ),
    ).toThrow("MCP_HEADERS_INVALID:a");
  });
});

describe("mergeTemplate", () => {
  it("模板 key 不存在则插入，已存在则保留原值", () => {
    const merged = mergeTemplate(
      '{\n  "mcpServers": {\n    "feishu": { "command": "keep" }\n  }\n}',
      { feishu: { command: "skip" }, tushare: { url: "https://tushare/mcp" } },
    );
    const parsed = JSON.parse(merged);
    expect(parsed.mcpServers.feishu).toEqual({ command: "keep" });
    expect(parsed.mcpServers.tushare).toEqual({ url: "https://tushare/mcp" });
  });
});

describe("syncParamsChanged", () => {
  it("字段全等（含键序不同的 canonical JSON）判定未变", () => {
    expect(
      syncParamsChanged(
        {
          transport: "stdio",
          command: "npx",
          args: '["--a","--b"]',
          env: '{"X":"1"}',
        },
        {
          transport: "stdio",
          command: "npx",
          args: '["--a", "--b"]',
          env: '{"X":"1"}',
        },
      ),
    ).toBe(false);
  });

  it("canonical 键序不同但内容相同判定未变", () => {
    expect(
      syncParamsChanged(
        { transport: "stdio", command: "npx", env: '{"A":"1","B":"2"}' },
        { transport: "stdio", command: "npx", env: '{"B":"2","A":"1"}' },
      ),
    ).toBe(false);
  });

  it("任一字段实质变化判定已变", () => {
    expect(
      syncParamsChanged(
        { transport: "http", url: "https://a" },
        { transport: "http", url: "https://b" },
      ),
    ).toBe(true);
    expect(
      syncParamsChanged(
        { transport: "stdio", command: "npx" },
        { transport: "stdio", command: "npx", args: '["--x"]' },
      ),
    ).toBe(true);
  });

  it("DB null（清空态）与 entry 缺省（undefined）视为相等（清空后幂等）", () => {
    expect(
      syncParamsChanged(
        {
          transport: "stdio",
          command: "npx",
          url: null,
          headers: null,
        },
        { transport: "stdio", command: "npx" },
      ),
    ).toBe(false);
  });
});

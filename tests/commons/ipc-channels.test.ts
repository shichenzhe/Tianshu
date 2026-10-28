// tests/commons/ipc-channels.test.ts
/** IPC 事件白名单：业务推送通道逐项放行（缺项 = preload 拒听 = 功能静默死亡） */
import { describe, expect, it } from "vitest";
import {
  IPC_INVOKE_ALLOWLIST,
  IPC_SEND_ALLOWLIST,
  IPC_EVENT_ALLOWLIST,
  IPC_EVENT_PREFIXES,
  isEventAllowed,
  isInvokeAllowed,
  isSendAllowed,
} from "../../electron/commons/ipc-channels";

describe("IPC 事件白名单", () => {
  it("放行 orchestration:node-status（试运行画布节点高亮）", () => {
    expect(isEventAllowed("orchestration:node-status")).toBe(true);
  });

  it("放行 orchestration:graphs-changed 与 automation:tasks-changed", () => {
    expect(isEventAllowed("orchestration:graphs-changed")).toBe(true);
    expect(isEventAllowed("automation:tasks-changed")).toBe(true);
  });

  it("放行动态前缀 chat:stream:<sessionId>，拒绝未知名通道", () => {
    expect(isEventAllowed("chat:stream:42")).toBe(true);
    expect(isEventAllowed("orchestration:unknown-event")).toBe(false);
  });
});

describe("ipc-channels detailPanel 新通道", () => {
  it("invoke 放行 terminal:create 与 workspace:listDir", () => {
    expect(IPC_INVOKE_ALLOWLIST).toContain("terminal:create");
    expect(IPC_INVOKE_ALLOWLIST).toContain("workspace:listDir");
  });

  it("invoke 放行 terminal:probe（挂载探活，pty 已退出时显示退出态）", () => {
    expect(IPC_INVOKE_ALLOWLIST).toContain("terminal:probe");
  });

  it("invoke 放行 terminal:replay（重挂回放缓冲，防切会话空白）", () => {
    expect(IPC_INVOKE_ALLOWLIST).toContain("terminal:replay");
    expect(isInvokeAllowed("terminal:replay")).toBe(true);
  });

  it("send 放行 terminal 写/缩放/关闭", () => {
    for (const ch of ["terminal:write", "terminal:resize", "terminal:kill"]) {
      expect(IPC_SEND_ALLOWLIST).toContain(ch);
    }
  });

  it("事件动态前缀放行 terminal:data: 与 terminal:exit:", () => {
    expect(IPC_EVENT_PREFIXES).toContain("terminal:data:");
    expect(IPC_EVENT_PREFIXES).toContain("terminal:exit:");
    expect(isEventAllowed("terminal:data:abc123")).toBe(true);
    expect(isEventAllowed("terminal:exit:abc123")).toBe(true);
  });
});

describe("ipc-channels web 工具联动通道", () => {
  it("事件放行 detailPanel:openBrowser", () => {
    expect(IPC_EVENT_ALLOWLIST).toContain("detailPanel:openBrowser");
    expect(isEventAllowed("detailPanel:openBrowser")).toBe(true);
  });
});

describe("ipc-channels browser_use 通道", () => {
  it("send 放行 browser:bindSession（渲染层 webview dom-ready 上报会话绑定）", () => {
    expect(IPC_SEND_ALLOWLIST).toContain("browser:bindSession");
  });
});

describe("ipc-changes 通道", () => {
  it("invoke 放行 workspace:gitStatus 与 workspace:gitDiff", () => {
    expect(IPC_INVOKE_ALLOWLIST).toContain("workspace:gitStatus");
    expect(IPC_INVOKE_ALLOWLIST).toContain("workspace:gitDiff");
  });
});

describe("ipc-channels 远程审批通道（T17）", () => {
  it("invoke 放行 server:sessionApprove（远控台审批应答透传）", () => {
    expect(IPC_INVOKE_ALLOWLIST).toContain("server:sessionApprove");
    expect(isInvokeAllowed("server:sessionApprove")).toBe(true);
  });
});

describe("ipc-channels 白名单负向（缺项即拒，防拼写绕过）", () => {
  it("send 未注册的 terminal:* 变体拒绝", () => {
    expect(isSendAllowed("terminal:foo")).toBe(false);
  });

  it("事件动态前缀裸名（无尾 id）拒绝：terminal:data 不等于 terminal:data:<id>", () => {
    expect(isEventAllowed("terminal:data")).toBe(false);
    expect(isEventAllowed("terminal:exit")).toBe(false);
  });

  it("invoke 未注册的 workspace:* 变体拒绝", () => {
    expect(isInvokeAllowed("workspace:nope")).toBe(false);
  });

  it("send 未注册的 workspace:* 拒绝（gitStatus 仅 invoke 通道）", () => {
    expect(isSendAllowed("workspace:gitStatus")).toBe(false);
    expect(IPC_EVENT_ALLOWLIST).not.toContain("terminal:data");
  });
});

// ws 应用层活性单元（T14；T11/T12 遗留 F1 在此一并解）：undici 全局
// WebSocket 无协议层 ping/pong（Electron 44 主进程实测 ws.ping undefined）
// → {kind:'ping'}/{kind:'pong'} 应用层帧。判死口径=deadAfterMs 内无任何
// 入站帧（任意帧皆活性证据——事件流繁忙的活链不误杀，静默死链必超窗）。
// 真实短时钟直测（不用 fake timers——与 ws/IO 混排不可靠）。
import { describe, expect, it, vi } from "vitest";
import { createWsLiveness } from "../../../electron/domains/server-face/ws-liveness";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createWsLiveness", () => {
  it("按间隔发 ping；持续入站帧不判死", async () => {
    const sendPing = vi.fn();
    const onDead = vi.fn();
    const liveness = createWsLiveness({
      sendPing,
      onDead,
      pingIntervalMs: 40,
      deadAfterMs: 120,
    });
    liveness.start();
    const ticker = setInterval(() => liveness.noteInbound(), 30);
    await sleep(280);
    clearInterval(ticker);
    expect(sendPing.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(onDead).not.toHaveBeenCalled();
    liveness.stop();
  }, 10000);

  it("无入站超窗判死：onDead 恰一次，之后不再发 ping", async () => {
    const sendPing = vi.fn();
    const onDead = vi.fn();
    const liveness = createWsLiveness({
      sendPing,
      onDead,
      pingIntervalMs: 30,
      deadAfterMs: 90,
    });
    liveness.start();
    await sleep(300);
    expect(onDead).toHaveBeenCalledTimes(1);
    const pingsAtDeath = sendPing.mock.calls.length;
    expect(pingsAtDeath).toBeGreaterThanOrEqual(2);
    await sleep(150);
    // 判死后计时器全清：不再发 ping、不重复判死
    expect(sendPing.mock.calls.length).toBe(pingsAtDeath);
    expect(onDead).toHaveBeenCalledTimes(1);
  }, 10000);

  it("stop 立即清窗：停止后无入站不判死", async () => {
    const onDead = vi.fn();
    const liveness = createWsLiveness({
      sendPing: () => {},
      onDead,
      pingIntervalMs: 40,
      deadAfterMs: 80,
    });
    liveness.start();
    liveness.stop();
    await sleep(220);
    expect(onDead).not.toHaveBeenCalled();
  }, 10000);
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ARCHIVE_UNDO_WINDOW_MS,
  archiveWithUndo,
  resetArchiveUndoForTest,
  undoArchive,
  type ArchiveUndoPorts,
} from "./archive-undo";

/** 端口替身：记录调用序列（写操作结果可控）；undoCallbacks 捕获撤销回调 */
function makePorts(overrides: Partial<ArchiveUndoPorts> = {}) {
  const calls: string[] = [];
  const undoCallbacks: Array<() => void> = [];
  return {
    calls,
    undoCallbacks,
    ports: {
      archive: vi.fn(async (id: number) => {
        calls.push(`archive:${id}`);
        return true;
      }),
      unarchive: vi.fn(async (id: number) => {
        calls.push(`unarchive:${id}`);
        return true;
      }),
      settle: vi.fn((id: number) => {
        calls.push(`settle:${id}`);
      }),
      notify: vi.fn(
        (message: string, undoLabel: string, onUndo: () => void) => {
          calls.push(`notify:${message}:${undoLabel}`);
          undoCallbacks.push(onUndo);
        },
      ),
      notifyError: vi.fn((message: string) => {
        calls.push(`error:${message}`);
      }),
      ...overrides,
    } satisfies ArchiveUndoPorts,
  };
}

const LABELS = { archived: "已归档", undo: "撤销", failed: "失败" };

describe("archive-undo 归档撤销编排（B5）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetArchiveUndoForTest();
  });
  afterEach(() => {
    resetArchiveUndoForTest();
    vi.useRealTimers();
  });

  it("归档成功即弹撤销条；窗口到点 settle 落定（无撤销则 unarchive 不触发）", async () => {
    const { calls, ports } = makePorts();
    archiveWithUndo({ id: 7 }, ports, LABELS);
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toEqual(["archive:7", "notify:已归档:撤销"]);
    expect(ports.settle).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(ARCHIVE_UNDO_WINDOW_MS);
    expect(calls).toEqual(["archive:7", "notify:已归档:撤销", "settle:7"]);
    expect(ports.unarchive).not.toHaveBeenCalled();
  });

  it("窗口内点撤销：unarchive 还原 + 清定时器（到点不再 settle）", async () => {
    const { calls, ports, undoCallbacks } = makePorts();
    archiveWithUndo({ id: 7 }, ports, LABELS);
    await vi.advanceTimersByTimeAsync(0);

    undoCallbacks[0]?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["archive:7", "notify:已归档:撤销", "unarchive:7"]);

    await vi.advanceTimersByTimeAsync(ARCHIVE_UNDO_WINDOW_MS * 2);
    expect(ports.settle).not.toHaveBeenCalled();
  });

  it("归档失败：notifyError 提示，不弹撤销条、不设定时器", async () => {
    const { calls, ports } = makePorts({
      archive: vi.fn(async () => false),
    });
    archiveWithUndo({ id: 7 }, ports, LABELS);
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toEqual(["error:失败"]);
    expect(ports.notify).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(ARCHIVE_UNDO_WINDOW_MS * 2);
    expect(ports.settle).not.toHaveBeenCalled();
  });

  it("撤销反操作失败：notifyError 提示", async () => {
    const { ports } = makePorts({
      unarchive: vi.fn(async () => false),
    });
    undoArchive(7, ports, LABELS);
    await vi.advanceTimersByTimeAsync(0);
    expect(ports.unarchive).toHaveBeenCalledWith(7);
    expect(ports.notifyError).toHaveBeenCalledWith("失败");
    expect(ports.settle).not.toHaveBeenCalled();
  });

  it("同会话重复归档：旧窗口作废（清定时器），新窗口到点只 settle 一次", async () => {
    const { calls, ports } = makePorts();
    archiveWithUndo({ id: 7 }, ports, LABELS);
    await vi.advanceTimersByTimeAsync(0);
    archiveWithUndo({ id: 7 }, ports, LABELS);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([
      "archive:7",
      "notify:已归档:撤销",
      "archive:7",
      "notify:已归档:撤销",
    ]);

    await vi.advanceTimersByTimeAsync(ARCHIVE_UNDO_WINDOW_MS);
    expect(calls.filter((c) => c === "settle:7")).toHaveLength(1);
  });

  it("暂存行归档按钮复用 undoArchive：直反操作还原（不经 notify）", async () => {
    const { calls, ports } = makePorts();
    undoArchive(7, ports, LABELS);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["unarchive:7"]);
    expect(ports.notify).not.toHaveBeenCalled();
  });
});

import { exec } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import {
  buildDescendantPids,
  matchBlacklistProgram,
  parsePsOutput,
  watchCommandTree,
  type ProcRow,
} from "../../electron/domains/security/child-monitor";

const rows: ProcRow[] = [
  { pid: 1, ppid: 0, comm: "launchd" },
  { pid: 10, ppid: 1, comm: "zsh" },
  { pid: 11, ppid: 10, comm: "node" },
  { pid: 12, ppid: 11, comm: "sh" },
  { pid: 13, ppid: 12, comm: "sleep" },
  { pid: 99, ppid: 1, comm: "unrelated" },
];

describe("parsePsOutput", () => {
  it("解析 PID PPID COMM 表（含空格 comm）", () => {
    const out = parsePsOutput(
      "  PID  PPID COMM\n   10     1 zsh\n   13    12 My Program\n",
    );
    expect(out).toEqual([
      { pid: 10, ppid: 1, comm: "zsh" },
      { pid: 13, ppid: 12, comm: "My Program" },
    ]);
  });
});

describe("buildDescendantPids", () => {
  it("root 的全部后代（多层），不含 root 与无关进程", () => {
    const desc = buildDescendantPids(rows, 10);
    expect(desc.has(11)).toBe(true);
    expect(desc.has(12)).toBe(true);
    expect(desc.has(13)).toBe(true);
    expect(desc.has(10)).toBe(false);
    expect(desc.has(99)).toBe(false);
  });
  it("成环不死循环", () => {
    const cyclic: ProcRow[] = [
      { pid: 20, ppid: 21, comm: "a" },
      { pid: 21, ppid: 20, comm: "b" },
    ];
    expect(() => buildDescendantPids(cyclic, 20)).not.toThrow();
  });
});

describe("matchBlacklistProgram", () => {
  it("comm 基名 ∈ 黑名单（含路径形态 comm）", () => {
    expect(matchBlacklistProgram("rm", ["rm"])).toBe(true);
    expect(matchBlacklistProgram("/usr/bin/rm", ["rm"])).toBe(true);
    expect(matchBlacklistProgram("rmrf", ["rm"])).toBe(false);
  });
});

describe("watchCommandTree（真实进程，unix only）", () => {
  it.runIf(process.platform !== "win32")(
    "黑名单子进程被 kill 并回调",
    async () => {
      const child = exec("sh -c 'sleep 30'");
      const pid = child.pid!;
      const violations: Array<{ pid: number; program: string }> = [];
      const stop = watchCommandTree(pid, ["sleep"], (v) => violations.push(v), {
        intervalMs: 100,
      });
      await sleep(1500);
      stop();
      expect(violations.length).toBeGreaterThanOrEqual(1);
      expect(violations[0].program).toBe("sleep");
      child.kill();
    },
    10_000,
  );
});

describe("watchCommandTree 轮询间隔（M5）", () => {
  it.runIf(process.platform !== "win32")(
    "默认间隔 1s（原 250ms：一条 60s 命令 = 240 次 ps 全系统快照，纯放大）",
    () => {
      const spy = vi.spyOn(globalThis, "setInterval");
      const stop = watchCommandTree(999999, [], () => {});
      expect(spy).toHaveBeenCalledWith(expect.any(Function), 1000);
      stop();
      spy.mockRestore();
    },
  );
});

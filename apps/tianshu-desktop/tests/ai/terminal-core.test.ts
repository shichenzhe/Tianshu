import { describe, expect, it, vi } from "vitest";
import {
  REPLAY_BUFFER_CAP,
  TerminalManager,
  defaultShell,
  type PtyFactory,
  type PtyProcess,
} from "../../electron/domains/ai/terminal/terminal-core";

class FakePty implements PtyProcess {
  written: string[] = [];
  killed = false;
  resized: Array<[number, number]> = [];
  dataCb?: (data: string) => void;
  exitCb?: (code: number) => void;
  write(data: string) {
    this.written.push(data);
  }
  resize(cols: number, rows: number) {
    this.resized.push([cols, rows]);
  }
  kill() {
    this.killed = true;
  }
  onData(cb: (data: string) => void) {
    this.dataCb = cb;
  }
  onExit(cb: (code: number) => void) {
    this.exitCb = cb;
  }
}

function makeFactory() {
  const ptys: FakePty[] = [];
  const factory = vi.fn(() => {
    const pty = new FakePty();
    ptys.push(pty);
    return pty;
  }) as unknown as PtyFactory & { ptys: FakePty[] };
  (factory as { ptys: FakePty[] }).ptys = ptys;
  return factory as PtyFactory & { ptys: FakePty[] };
}

describe("TerminalManager", () => {
  it("create 登记并返回不同 id，cwd 透传", () => {
    const factory = makeFactory();
    const manager = new TerminalManager(factory, vi.fn());
    const id1 = manager.create(vi.fn(), "/tmp/a");
    const id2 = manager.create(vi.fn(), "/tmp/b");
    expect(id1).toBeTruthy();
    expect(id1).not.toBe(id2);
    expect(factory).toHaveBeenCalledWith(
      expect.any(String),
      [],
      expect.objectContaining({ cwd: "/tmp/a" }),
    );
  });

  it("write/resize 转发到对应 pty", () => {
    const factory = makeFactory();
    const manager = new TerminalManager(factory, vi.fn());
    const id = manager.create(vi.fn(), "/tmp");
    manager.write(id, "ls\r");
    manager.resize(id, 120, 30);
    expect(factory.ptys[0].written).toEqual(["ls\r"]);
    expect(factory.ptys[0].resized).toEqual([[120, 30]]);
  });

  it("未知 id 的 write/resize/kill 静默不抛", () => {
    const manager = new TerminalManager(makeFactory(), vi.fn());
    expect(() => {
      manager.write("nope", "x");
      manager.resize("nope", 1, 1);
      manager.kill("nope");
    }).not.toThrow();
  });

  it("pty data 经各自 sender 推送 terminal:data:<id>", () => {
    const factory = makeFactory();
    const manager = new TerminalManager(factory, vi.fn());
    const sender1 = vi.fn();
    const sender2 = vi.fn();
    const id1 = manager.create(sender1, "/tmp");
    manager.create(sender2, "/tmp");
    factory.ptys[0].dataCb?.("hello");
    factory.ptys[1].dataCb?.("world");
    expect(sender1).toHaveBeenCalledWith(`terminal:data:${id1}`, "hello");
    expect(sender2).toHaveBeenCalledTimes(1);
  });

  it("pty exit 推送 terminal:exit:<id> 并移除登记", () => {
    const factory = makeFactory();
    const manager = new TerminalManager(factory, vi.fn());
    const sender = vi.fn();
    const id = manager.create(sender, "/tmp");
    factory.ptys[0].exitCb?.(0);
    expect(sender).toHaveBeenCalledWith(`terminal:exit:${id}`, "0");
    expect(manager.count()).toBe(0);
    manager.kill(id); // 已移除，幂等
  });

  it("kill 后迟到 exit 回调不误删同 id 新登记、不向新 sender 二次推送", () => {
    const factory = makeFactory();
    const manager = new TerminalManager(factory, vi.fn());
    const sender1 = vi.fn();
    const id1 = manager.create(sender1, "/tmp");
    manager.kill(id1); // 登记即移除；真实 pty.kill 后 exit 回调可能迟到
    const sender2 = vi.fn();
    const id2 = manager.create(sender2, "/tmp");
    // 模拟同 id 重新登记：create 用 randomUUID 无法指定 id，把 entry2 改挂
    // 到 id1 下（直接检验 exitCb 里 get(id)===entry 的新旧登记守卫）
    const terminals = (
      manager as unknown as { terminals: Map<string, unknown> }
    ).terminals;
    const entry2 = terminals.get(id2);
    terminals.delete(id2);
    terminals.set(id1, entry2);
    // 触发旧 pty 的迟到 exit：不抛、新登记原样存活、exit 只推旧 sender
    expect(() => factory.ptys[0].exitCb?.(0)).not.toThrow();
    expect(terminals.get(id1)).toBe(entry2);
    expect(manager.has(id1)).toBe(true);
    expect(manager.count()).toBe(1);
    expect(sender1).toHaveBeenCalledWith(`terminal:exit:${id1}`, "0");
    expect(sender2).not.toHaveBeenCalled();
  });

  it("kill 调用 pty.kill；killAll 清空全部", () => {
    const factory = makeFactory();
    const manager = new TerminalManager(factory, vi.fn());
    const id1 = manager.create(vi.fn(), "/tmp");
    manager.create(vi.fn(), "/tmp");
    manager.kill(id1);
    expect(factory.ptys[0].killed).toBe(true);
    expect(factory.ptys[1].killed).toBe(false);
    manager.killAll();
    expect(factory.ptys[1].killed).toBe(true);
    expect(manager.count()).toBe(0);
  });

  it("has：create 后 true，kill/pty 自然退出后 false，未知 id false", () => {
    const factory = makeFactory();
    const manager = new TerminalManager(factory, vi.fn());
    expect(manager.has("nope")).toBe(false);
    const id1 = manager.create(vi.fn(), "/tmp");
    const id2 = manager.create(vi.fn(), "/tmp");
    expect(manager.has(id1)).toBe(true);
    manager.kill(id1);
    expect(manager.has(id1)).toBe(false);
    // pty 在挂起窗口自然退出同样移除登记——重挂探活（probe）据此判 false
    factory.ptys[1].exitCb?.(0);
    expect(manager.has(id2)).toBe(false);
  });

  it("create 时 factory 抛错向上传播", () => {
    const factory: PtyFactory = () => {
      throw new Error("spawn failed");
    };
    const manager = new TerminalManager(factory, vi.fn());
    expect(() => manager.create(vi.fn(), "/tmp")).toThrow("spawn failed");
  });
});

describe("TerminalManager replay 回放缓冲", () => {
  it("多 chunk 按序拼接返回；实时推送不受影响", () => {
    const factory = makeFactory();
    const manager = new TerminalManager(factory, vi.fn());
    const sender = vi.fn();
    const id = manager.create(sender, "/tmp");
    factory.ptys[0].dataCb?.("ab");
    factory.ptys[0].dataCb?.("cd");
    expect(manager.replay(id)).toBe("abcd");
    expect(sender).toHaveBeenCalledWith(`terminal:data:${id}`, "ab");
    expect(sender).toHaveBeenCalledWith(`terminal:data:${id}`, "cd");
  });

  it("空缓冲（刚 create 未出数据）返回空串", () => {
    const manager = new TerminalManager(makeFactory(), vi.fn());
    const id = manager.create(vi.fn(), "/tmp");
    expect(manager.replay(id)).toBe("");
  });

  it("超 cap 丢最旧整 chunk，尾部保留", () => {
    const factory = makeFactory();
    const manager = new TerminalManager(factory, vi.fn());
    const id = manager.create(vi.fn(), "/tmp");
    const cb = factory.ptys[0].dataCb!;
    cb("x".repeat(60000));
    cb("y".repeat(60000));
    cb("z".repeat(60000)); // 180000 > cap → 丢最旧 60000
    cb("tail"); // 120004 ≤ cap 稳态
    expect(manager.replay(id)).toBe(
      "y".repeat(60000) + "z".repeat(60000) + "tail",
    );
  });

  it("单 chunk 超 cap：截头保留尾部 cap 长度", () => {
    const factory = makeFactory();
    const manager = new TerminalManager(factory, vi.fn());
    const id = manager.create(vi.fn(), "/tmp");
    factory.ptys[0].dataCb?.("a".repeat(REPLAY_BUFFER_CAP + 5000));
    const out = manager.replay(id);
    expect(out.length).toBe(REPLAY_BUFFER_CAP);
    expect(out).toBe("a".repeat(REPLAY_BUFFER_CAP));
  });

  it("头部对齐首个换行（防 ANSI 序列被 cap 腰斩）；无换行原样返回", () => {
    const factory = makeFactory();
    const manager = new TerminalManager(factory, vi.fn());
    const id = manager.create(vi.fn(), "/tmp");
    factory.ptys[0].dataCb?.("残留半行\x1b[31m\n完整行A\n完整行B");
    expect(manager.replay(id)).toBe("完整行A\n完整行B");

    const factory2 = makeFactory();
    const manager2 = new TerminalManager(factory2, vi.fn());
    const id2 = manager2.create(vi.fn(), "/tmp");
    factory2.ptys[0].dataCb?.("no-newline-single-line");
    expect(manager2.replay(id2)).toBe("no-newline-single-line");
  });

  it("未知 id / kill 后 / pty 自然退出后 replay 抛错（缓冲随登记释放）", () => {
    const factory = makeFactory();
    const manager = new TerminalManager(factory, vi.fn());
    expect(() => manager.replay("nope")).toThrow();

    const id1 = manager.create(vi.fn(), "/tmp");
    manager.kill(id1);
    expect(() => manager.replay(id1)).toThrow();

    const id2 = manager.create(vi.fn(), "/tmp");
    factory.ptys[1].exitCb?.(0);
    expect(() => manager.replay(id2)).toThrow();
  });
});

describe("defaultShell", () => {
  it("win32 返回 powershell", () => {
    expect(defaultShell("win32")).toBe("powershell.exe");
  });
  it("darwin 兜底 /bin/zsh，linux 兜底 /bin/bash", () => {
    // 实现的 shellEnv 默认值是 process.env.SHELL，显式传 undefined 仍会
    // 触发默认参数；须清空 SHELL 才能真实进入平台兜底分支
    vi.stubEnv("SHELL", "");
    try {
      expect(defaultShell("darwin", undefined)).toBe("/bin/zsh");
      expect(defaultShell("linux", undefined)).toBe("/bin/bash");
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("SHELL 环境变量优先", () => {
    expect(defaultShell("darwin", "/usr/local/bin/fish")).toBe(
      "/usr/local/bin/fish",
    );
  });
});

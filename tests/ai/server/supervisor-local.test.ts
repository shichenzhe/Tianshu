// 本地无头端 spawn 链路（仅 dev 态）：resolveLocalServerCommand 解析
// node + 兄弟仓产物入口；startLocalServer 真冒烟——marker 文件观测子进程
// 侧 env（TIANSHU_TOKEN 透传 + argv[1]）。打包态安装包不内嵌无头端
// （2026-10-27 拆除内嵌裁定）——startLocalServer 前置守卫拒绝。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appMock = vi.hoisted(() => ({ isPackaged: false }));
vi.mock("electron", () => ({ app: appMock }));
vi.mock("../../../electron/commons/Log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// prisma 替身：option 表内存实现（connections.test 同款，仅本文件所需子集）
const optionRows: Array<{
  id: number;
  type: string;
  name: string;
  value: string;
}> = [];
const prismaStub = vi.hoisted(() => ({
  option: {
    findFirst: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
  },
}));
vi.mock("../../../electron/commons/prisma-client", () => ({
  default: prismaStub,
}));

import {
  ConnectionRegistry,
  resolveLocalServerCommand,
  startLocalServer,
  stopLocalServer,
} from "../../../electron/domains/server/connections";
import { HANDSHAKE_PREFIX } from "../../../electron/domains/server/supervisor";

/** fake 产物脚本：marker 文件落盘子进程观测值（token/argv[1]）→ 握手行
 * 保活（SIGTERM 处理器先于握手行注册契约同款） */
function fakeMainScript(markerPath: string): string {
  return [
    "process.on('SIGTERM', () => process.exit(0));",
    `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({`,
    "  token: process.env.TIANSHU_TOKEN ?? null,",
    "  argv1: process.argv[1],",
    "}));",
    `console.log('${HANDSHAKE_PREFIX}${JSON.stringify({
      port: 3999,
      token: "local-tok",
      instanceId: "local-inst",
    })}');`,
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n");
}

const registries: ConnectionRegistry[] = [];

function newRegistry(): ConnectionRegistry {
  const registry = new ConnectionRegistry();
  registries.push(registry);
  return registry;
}

beforeEach(() => {
  optionRows.length = 0;
  prismaStub.option.findFirst.mockImplementation(
    async (args: {
      where: { type: string; name: string };
      select?: unknown;
    }) => {
      const row = optionRows.find(
        (r) => r.type === args.where.type && r.name === args.where.name,
      );
      if (!row) return null;
      return args.select ? { id: row.id } : row;
    },
  );
  prismaStub.option.update.mockImplementation(
    async (args: { where: { id: number }; data: { value: string } }) => {
      const row = optionRows.find((r) => r.id === args.where.id)!;
      row.value = args.data.value;
      return row;
    },
  );
  prismaStub.option.create.mockImplementation(
    async (args: { data: { type: string; name: string; value: string } }) => {
      const row = { id: optionRows.length + 1, ...args.data };
      optionRows.push(row);
      return row;
    },
  );
});

afterEach(() => {
  appMock.isPackaged = false;
  for (const registry of registries) registry.closeAll();
  registries.length = 0;
});

describe("resolveLocalServerCommand（dev 态）", () => {
  it("node + 兄弟仓产物入口（现状链路）", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-dev-"));
    try {
      fs.mkdirSync(path.join(projectDir, "dist", "src"), { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, "dist", "src", "main.js"),
        "// fake",
      );
      expect(resolveLocalServerCommand(projectDir)).toEqual({
        command: "node",
        args: [path.join(projectDir, "dist", "src", "main.js")],
        cwd: projectDir,
      });
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("产物缺失 → 提示 tianshu-server 仓 build", () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-devmiss-"));
    try {
      expect(() => resolveLocalServerCommand(emptyDir)).toThrow(
        /无头端产物不存在.*npm run build/s,
      );
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

describe("startLocalServer（dev 冒烟 + 打包守卫）", () => {
  it("dev：spawn node 跑兄弟仓产物，TIANSHU_TOKEN 透传、argv[1]=入口", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-devspawn-"));
    const markerPath = path.join(projectDir, "marker.json");
    fs.mkdirSync(path.join(projectDir, "dist", "src"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "dist", "src", "main.js"),
      fakeMainScript(markerPath),
    );
    const registry = newRegistry();
    try {
      const info = await startLocalServer(registry, projectDir);
      expect(info.instanceId).toBe("local-inst");
      const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as {
        token: string | null;
        argv1: string;
      };
      // TIANSHU_TOKEN 透传（注入值非握手回显值——两源不同值即证透传）
      expect(marker.token).toBeTruthy();
      expect(marker.token).not.toBe("local-tok");
      expect(marker.argv1).toBe(
        path.join(projectDir, "dist", "src", "main.js"),
      );
    } finally {
      await stopLocalServer(registry);
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("打包态：前置守卫拒绝（安装包不内嵌无头端，指引独立部署）", async () => {
    appMock.isPackaged = true;
    const registry = newRegistry();
    await expect(startLocalServer(registry, "/any")).rejects.toThrow(
      /打包版不内置本地无头端.*独立部署/s,
    );
  });
});

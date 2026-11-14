/**
 * macOS Seatbelt 实现（OS 沙箱 spec §4）：sandbox-exec 包装 + 组件探测。
 * 调用形态：sandbox-exec -p '<sbpl>' /bin/zsh -c '<原命令>'——
 * Seatbelt 系统内置零依赖（不碰 allowScripts/双 ABI/原生自愈链），
 * 原 shell 语义经内层 zsh 无损重建（单引号包装透传任意命令形态）。
 * 写白名单语义见 profile.ts；网络/读/进程执行零约束（裁定 #2）。
 */
import fs from "node:fs";
import os from "node:os";
import type { SandboxRunner, SandboxWrapOptions, SandboxWrapResult } from "./runner";
import { buildSeatbeltProfile, normalizeMacPrivatePath } from "./profile";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** sandbox-exec 探测（spec §4.6）：进程内一次缓存；Apple 若移除自动降级透传 */
let availableCache: boolean | undefined;

export function seatbeltAvailable(): boolean {
  if (availableCache === undefined) {
    try {
      fs.accessSync(SANDBOX_EXEC, fs.constants.X_OK);
      availableCache = true;
    } catch {
      availableCache = false;
    }
  }
  return availableCache;
}

/** realpath 失败回落 /private 前缀归一（常见符号链接仍被覆盖） */
function realpathSafe(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return normalizeMacPrivatePath(p);
  }
}

/** sh 单引号无损包装（外层 exec 经 /bin/sh -c 解析整串，sbpl 与命令各为一个参数） */
function shellSingleQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Seatbelt 包装（spec §4.1/§4.2）：full 档不进沙箱（裁定假设 #1），
 * 探测失败透传（fail-open，裁定假设 #3） */
function seatbeltWrap(
  command: string,
  opts: SandboxWrapOptions,
): SandboxWrapResult {
  if (opts.fullAccess || !seatbeltAvailable()) {
    return { command, sandboxed: false };
  }
  const anchor = opts.workspacePath || os.homedir();
  const profile = buildSeatbeltProfile(
    realpathSafe(anchor),
    realpathSafe(os.tmpdir()),
  );
  return {
    command: `sandbox-exec -p ${shellSingleQuote(profile)} /bin/zsh -c ${shellSingleQuote(command)}`,
    sandboxed: true,
  };
}

export const SeatbeltRunner: SandboxRunner = {
  available: seatbeltAvailable,
  wrap: seatbeltWrap,
};

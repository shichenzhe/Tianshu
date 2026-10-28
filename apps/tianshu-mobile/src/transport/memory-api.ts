// 记忆进化批 memory 面 wire（桌面被控面专属五端点；无头端不实现不报——
// capability memory 门禁后调用，旧宿主 404 走 wire 失败臂）。
import {
  ENDPOINTS,
  type MemoryServiceResult,
  type MemoryState,
} from "@tianshu/protocol";

import { wireRequest } from "./wire";
import type { ApiResult } from "./graph-api";

export type { MemoryServiceResult, MemoryState } from "@tianshu/protocol";

export async function memoryGet(): Promise<ApiResult<MemoryState>> {
  const r = await wireRequest("POST", ENDPOINTS.memory.get, {});
  return r.ok ? { ok: true, data: r.data as MemoryState } : r;
}

export async function memorySaveConfig(payload: {
  enabled?: boolean;
  modelId?: number | null;
}): Promise<ApiResult<MemoryState>> {
  const r = await wireRequest("POST", ENDPOINTS.memory.saveConfig, payload);
  return r.ok ? { ok: true, data: r.data as MemoryState } : r;
}

export async function memorySaveProfile(
  profile: string,
): Promise<ApiResult<MemoryState>> {
  const r = await wireRequest("POST", ENDPOINTS.memory.saveProfile, {
    profile,
  });
  return r.ok ? { ok: true, data: r.data as MemoryState } : r;
}

export async function memoryApplyInstruction(
  instruction: string,
): Promise<ApiResult<MemoryServiceResult>> {
  const r = await wireRequest("POST", ENDPOINTS.memory.applyInstruction, {
    instruction,
  });
  return r.ok ? { ok: true, data: r.data as MemoryServiceResult } : r;
}

export async function memoryCompile(): Promise<ApiResult<MemoryServiceResult>> {
  const r = await wireRequest("POST", ENDPOINTS.memory.compile, {});
  return r.ok ? { ok: true, data: r.data as MemoryServiceResult } : r;
}

/**
 * SkillHub 市场客户端(主进程;P-B spec §2):信封解包、指数退避、鉴权头。
 * fetchImpl/baseUrl 注入可测;真实 Key 经 Constants(env 覆盖/init 占位符),不入库
 */
import { createHash } from "node:crypto";
import os from "node:os";

import { Constants } from "../../../Constants";

export interface SkillHubSkill {
  slug: string;
  name: string;
  description: string;
  description_zh: string;
  iconUrl: string | null;
  category: string;
  version: string;
  downloads: number;
  stars: number;
  score: number;
  source: string;
}

export interface SkillHubCategory {
  key: string;
  name: string;
  nameEn: string;
  sortOrder: number;
  active?: boolean;
}

export interface SkillHubListParams {
  keyword?: string;
  category?: string;
  page?: number;
  pageSize?: number;
  sortBy?: string;
  order?: "asc" | "desc";
}

export interface SkillHubPage {
  total: number;
  skills: SkillHubSkill[];
}

/** 详情接口裸对象(/api/v1/skills/{slug});只声明消费字段 */
export interface SkillHubSkillDetail {
  skill: { slug: string; version?: string };
  latestVersion: { version: string };
}

const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 1000;
const TIMEOUT_MS = 10_000;

/**
 * Key 未配置的哨兵值(与 Constants 默认值一致)。
 * 拆两段拼接:npm run init 会把占位符整串替换为真实值,本文件不出现完整字面量
 */
const API_KEY_PLACEHOLDER = "skh-your-api" + "-key";

/** 业务错误(HTTP 语义错误/信封非 0 code):不参与重试,直接抛给调用方 */
class SkillHubApiError extends Error {}

/** 可重试:429、5xx(4xx 语义错误不重试;网络异常走 catch 分支) */
function retryable(status: number): boolean {
  return status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SkillHubClient {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl: string = "https://api.skillhub.cn",
  ) {}

  private async request<T>(
    path: string,
    query?: Record<string, string | number | undefined>,
  ): Promise<T> {
    const entries = Object.entries(query ?? {}).filter(
      ([, v]) => v !== undefined,
    ) as Array<[string, string]>;
    // encodeURIComponent 序列化(空格 → %20;URLSearchParams 会转 +)
    const qs = entries.length
      ? "?" +
        entries
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join("&")
      : "";
    const res = await this.fetchWithRetry(`${this.baseUrl}${path}${qs}`);
    const body = (await res.json().catch(() => null)) as
      | { error?: string }
      | { code?: number; message?: string; data?: unknown }
      | null;
    // 信封(code/message/data)接口与裸对象接口区分:有 code 字段视为信封
    if (body && typeof body === "object" && "code" in body) {
      const envelope = body as {
        code: number;
        message?: string;
        data: unknown;
      };
      if (envelope.code !== 0) {
        throw new SkillHubApiError(envelope.message || `code ${envelope.code}`);
      }
      return envelope.data as T;
    }
    return body as T;
  }

  /**
   * GET + 鉴权头 + 超时 + 重试(429/5xx/网络异常),返回 2xx 原始 Response。
   * JSON 与二进制下载共用;非 2xx 耗尽重试或不可重试时抛 {error} 文案
   */
  private async fetchWithRetry(url: string): Promise<Response> {
    let lastError: Error = new Error("未发起请求");
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 1) {
        await sleep(RETRY_BASE_MS * 2 ** (attempt - 2));
      }
      try {
        const res = await this.fetchImpl(url, {
          headers: skillhubHeaders(),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            error?: string;
          } | null;
          const message = (body && body.error) || `HTTP ${res.status}`;
          if (retryable(res.status) && attempt < MAX_ATTEMPTS) {
            lastError = new Error(message);
            continue;
          }
          throw new SkillHubApiError(message);
        }
        return res;
      } catch (e) {
        if (e instanceof SkillHubApiError) {
          throw e;
        }
        lastError = e instanceof Error ? e : new Error(String(e));
        if (attempt >= MAX_ATTEMPTS) {
          throw lastError;
        }
      }
    }
    throw lastError;
  }

  async listSkills(params: SkillHubListParams): Promise<SkillHubPage> {
    const data = await this.request<{
      total: number;
      skills: SkillHubSkill[];
    }>("/api/skills", {
      keyword: params.keyword,
      category: params.category,
      page: params.page,
      pageSize: params.pageSize,
      sortBy: params.sortBy,
      order: params.order,
    });
    return data;
  }

  async listTop(): Promise<SkillHubSkill[]> {
    const data = await this.request<{ total: number; skills: SkillHubSkill[] }>(
      "/api/skills/top",
    );
    return data.skills;
  }

  async listCategories(): Promise<SkillHubCategory[]> {
    const data = await this.request<{ items: SkillHubCategory[] }>(
      "/api/v1/categories",
    );
    return data.items
      .filter((c) => c.active !== false)
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }

  /** 技能详情(裸对象;安装/详情页消费 latestVersion) */
  async getDetail(slug: string): Promise<SkillHubSkillDetail> {
    return this.request<SkillHubSkillDetail>(
      `/api/v1/skills/${encodeURIComponent(slug)}`,
    );
  }

  /**
   * 二进制 zip 下载:不走 request(其 JSON 解析/信封解包对 zip 不适用),
   * 复用鉴权头与重试策略;fetch 默认跟随 302
   */
  async downloadZip(slug: string): Promise<ArrayBuffer> {
    const res = await this.fetchWithRetry(
      `${this.baseUrl}/api/v1/download?slug=${encodeURIComponent(slug)}`,
    );
    return res.arrayBuffer();
  }
}

/**
 * 鉴权头:Key 空串/占位符不发;User-Id 用机器级稳定脱敏标识
 * (os 同步可用,免 electron 依赖)
 */
function skillhubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Client-User-Id": machineUserId(),
  };
  const apiKey = Constants.SKILLHUB_API_KEY;
  if (apiKey && apiKey !== API_KEY_PLACEHOLDER) {
    headers["X-API-Key"] = apiKey;
  }
  return headers;
}

/** hostname:username 的 sha256 前 16 位(脱敏、跨重启稳定、纯 node:crypto 同步) */
function machineUserId(): string {
  return createHash("sha256")
    .update(`${os.hostname()}:${os.userInfo().username}`)
    .digest("hex")
    .slice(0, 16);
}

/** 精选区换一换:Fisher-Yates(从后往前,j = floor(random() * (i + 1))),纯函数不改输入 */
export function shuffleTop<T>(
  items: T[],
  random: () => number = Math.random,
): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

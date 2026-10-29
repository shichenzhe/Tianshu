/**
 * agent 网页工具（自 mirror electron/domains/ai/agent/web-tools.ts 移植）：
 * 纯 Node 可测（fetch 注入可替换）。SSRF 复用封锁清单，重定向手动逐跳
 * follow（fetch redirect:"manual"），每跳重过 assertUrl，封死公网 302 跳
 * 内网 metadata 的绕过。
 * 无头端裁剪：browse（渲染层面板联动，emitPanel 依赖）不注册——
 * 本模块只保留 fetch；镜像 proxy-dispatcher 全局 dispatcher 未移植，
 * 直接走 Node 原生 global fetch（服务端出网按部署环境网络策略）。
 */
import { z } from 'zod';
import { isSsrfHost } from './ssrf-hosts';
import type { ToolDefinition } from './tool-definition';
import { fail } from './file-tools';

const FETCH_TIMEOUT_MS = 15_000;
const BODY_LIMIT = 1024 * 1024;
const CONTENT_LIMIT = 32 * 1024;

export type WebFetcher = (
  url: string,
  opts: { signal: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  /** 流式读取器（实现负责上限截断） */
  text: () => Promise<string>;
}>;

/** 校验放行的 url（协议 + SSRF）；拒绝返回原因文案 */
function assertUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '无效 URL';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return '仅支持 http/https';
  }
  if (isSsrfHost(parsed.hostname)) {
    return '禁止访问云 metadata 内网地址';
  }
  return null;
}

/** 手动 follow 重定向（≤5 跳）：每跳过 assertUrl（SSRF/协议），Location
 *  相对地址以当前跳为基解析；最终 2xx/4xx 返回，30x 超限失败 */
export async function fetchWithRedirects(
  fetcher: WebFetcher,
  url: string,
  opts: { signal: AbortSignal },
): Promise<Awaited<ReturnType<WebFetcher>>> {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    const bad = assertUrl(current);
    if (bad) throw new Error(bad);
    const res = await fetcher(current, opts);
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) return res;
      current = new URL(location, current).toString();
      continue;
    }
    return res;
  }
  throw new Error('重定向次数超限（>5）');
}

/** HTML→文本：剥 script/style 块与标签、实体折叠、空白压缩（零依赖） */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleOf(html: string): string {
  return (
    html
      .match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
      ?.trim()
      .slice(0, 200) ?? ''
  );
}

function makeWebFetchTool(
  fetcher: WebFetcher,
): ToolDefinition<{ url: string }> {
  return {
    name: 'fetch',
    description: '抓取网页并提取纯文本正文（超 32KB 截断）',
    parameters: z.object({ url: z.string().describe('要读取的网页地址') }),
    kind: 'read',
    execute: async (_ctx, { url }) => {
      // SSRF/协议校验先于任何网络请求（不发包）
      const bad = assertUrl(url);
      if (bad) return fail(bad);
      let res: Awaited<ReturnType<WebFetcher>>;
      try {
        res = await fetcher(url, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
      } catch (e) {
        return fail(`请求失败: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!res.ok) return fail(`HTTP ${res.status}`);
      const contentType = res.headers.get('content-type') ?? '';
      if (!/text\/html|text\/plain/i.test(contentType)) {
        return fail(
          `不支持的 Content-Type: ${contentType || '未知'}（仅 text/html、text/plain）`,
        );
      }
      let body: string;
      try {
        // 读体中断/流式超限（defaultFetcher 的字节预算）也回喂 fail 文案
        body = await res.text();
      } catch (e) {
        return fail(
          `读取响应体失败: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      if (body.length > BODY_LIMIT) return fail('响应体过大（超过 1MB）');
      const isHtml = /text\/html/i.test(contentType);
      const text = isHtml ? htmlToText(body) : body.replace(/\s+/g, ' ').trim();
      const title = isHtml ? titleOf(body) : '';
      const header = `URL: ${url}${title ? `\n标题: ${title}` : ''}\n---\n`;
      if (header.length + text.length > CONTENT_LIMIT) {
        return `${header}${text.slice(0, CONTENT_LIMIT - header.length)}\n\n[正文超过 32KB，已截断]`;
      }
      return header + text;
    },
  };
}

/**
 * 响应体流式读取（字节预算）：消费 body reader 逐块累积，超限即弃流抛错
 * （字节级在默认 fetcher 层先挡）；无 body 回退 res.text()。
 */
async function readBodyWithLimit(res: Response): Promise<string> {
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > BODY_LIMIT) {
      try {
        await reader.cancel();
      } catch {
        // 取消失败可忽略：连接由 abort 信号/连接池回收
      }
      throw new Error('响应体过大（超过 1MB）');
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString('utf8');
}

/** 原始 global fetch 适配：redirect:"manual" 让 3xx 透出给
 *  fetchWithRedirects 逐跳校验 + text() 走流式字节预算 */
const rawFetch: WebFetcher = async (url, opts) => {
  const res = await fetch(url, {
    signal: opts.signal,
    redirect: 'manual',
  });
  return {
    ok: res.ok,
    status: res.status,
    headers: res.headers,
    text: () => readBodyWithLimit(res),
  };
};

/** 默认 fetcher：rawFetch + 手动逐跳重定向 SSRF 校验 */
const defaultFetcher: WebFetcher = (url, opts) =>
  fetchWithRedirects(rawFetch, url, opts);

/** 无头端工具集：仅 fetch（browse 不注册） */
export function makeWebTools(
  fetcher: WebFetcher = defaultFetcher,
): ToolDefinition[] {
  return [makeWebFetchTool(fetcher)];
}

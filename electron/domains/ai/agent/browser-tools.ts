/**
 * browser_use 工具组（spec R19-R23）：操控会话绑定的右栏浏览器 tab。
 * 页面脚本注入铁律：所有动态参数（序号/文本）JSON.stringify 转义后嵌
 * 模板；脚本仅元素定位/赋值/事件派发。快照文本化（≤200 元素/80 字符
 * 文本/4KB 摘要，R20）；click/type 为 write（R21 走审批链）。
 */
import { z } from "zod";
import { isSsrfHost } from "../../security/ssrf-hosts";
import type { ToolDefinition } from "./file-tools";
import { fail } from "./file-tools";

export interface GuestControl {
  executeJavaScript(code: string): Promise<unknown>;
  loadURL(url: string): Promise<void>;
}
/** 图执行无会话（null）解析必 null——工具回「无可操控浏览器页」正确降级 */
export type GuestControlResolver = (
  sessionId: number | null,
) => GuestControl | null;

const SNAPSHOT_ITEMS_LIMIT = 200;
const SNAPSHOT_BODY_LIMIT = 4096;

/** 页面内采集脚本（IIFE 字符串；SNAPSHOT_MARKER 供测试识别） */
const SNAPSHOT_SCRIPT = `(() => { /* SNAPSHOT_MARKER */
  const sel = 'a, button, input, select, textarea, [onclick], [role="button"], [role="link"]';
  const els = Array.from(document.querySelectorAll(sel)).slice(0, ${SNAPSHOT_ITEMS_LIMIT});
  els.forEach((el, i) => el.setAttribute("data-ts-ai", String(i)));
  const items = els.map((el, i) => ({
    idx: i,
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute("type") || "",
    text: String(el.innerText || el.value || el.getAttribute("aria-label") || "").trim().slice(0, 80),
    href: el.tagName === "A" ? String(el.getAttribute("href") || "").slice(0, 120) : "",
  }));
  return JSON.stringify({
    title: document.title,
    url: location.href,
    items,
    body: String(document.body ? document.body.innerText : "").replace(/\\s+/g, " ").slice(0, ${SNAPSHOT_BODY_LIMIT}),
  });
})()`;

/** 快照序号 → 选择器表达式：idx 经 JSON.stringify 转义后剥外层引号
 *  嵌入 data-ts-ai 属性值（转义保留，防注入；序号纯数字由 zod int 校验，
 *  此处 Number.isInteger 守卫兜底非 zod 路径——非整数抛错走外层 fail） */
function selectorExpr(idx: number): string {
  if (!Number.isInteger(idx)) {
    throw new Error(`元素序号必须为整数，收到: ${idx}`);
  }
  const attr = JSON.stringify(String(idx)).slice(1, -1);
  return `'[data-ts-ai="${attr}"]'`;
}

function clickScript(idx: number): string {
  return `((sel) => {
  const el = document.querySelector(sel);
  if (!el) return "NOT_FOUND";
  const r = el.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, view: window, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
  el.dispatchEvent(new MouseEvent("mousedown", o));
  el.dispatchEvent(new MouseEvent("mouseup", o));
  el.dispatchEvent(new MouseEvent("click", o));
  return "OK";
})(${selectorExpr(idx)})`;
}

function typeScript(idx: number, text: string): string {
  return `((sel, text) => {
  const el = document.querySelector(sel);
  if (!el) return "NOT_FOUND";
  el.focus();
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value");
  if (setter && setter.set) setter.set.call(el, text); else el.value = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return "OK";
})(${selectorExpr(idx)}, ${JSON.stringify(text)})`;
}

/** url 校验（与 web-tools assertUrl 同语义；未导出故本地同构实现） */
function assertUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "无效 URL";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "仅支持 http/https";
  }
  if (isSsrfHost(parsed.hostname)) {
    return "禁止访问云 metadata 内网地址";
  }
  return null;
}

const NO_TAB = "当前会话没有可操控的浏览器页——先调用 open_browser 打开页面";

export function makeBrowserTools(
  resolve: GuestControlResolver,
): ToolDefinition[] {
  const snapshot: ToolDefinition<Record<string, never>> = {
    name: "browser_snapshot",
    description: "读取浏览器页快照（可交互元素序号与正文摘要）",
    parameters: z.object({}),
    kind: "read",
    execute: async (ctx) => {
      const control = resolve(ctx.sessionId);
      if (!control) return fail(NO_TAB);
      try {
        const raw = await control.executeJavaScript(SNAPSHOT_SCRIPT);
        if (typeof raw !== "string") return fail("页面快照返回异常");
        const parsed = JSON.parse(raw) as {
          title: string;
          url: string;
          items: Array<Record<string, unknown>>;
          body: string;
        };
        const lines = parsed.items
          .map(
            (i) =>
              `idx: ${i.idx} [${i.tag}${i.type ? ":" + i.type : ""}] ${i.text}${i.href ? ` → ${i.href}` : ""}`,
          )
          .join("\n");
        return `标题: ${parsed.title}\nURL: ${parsed.url}\n\n[可交互元素]\n${lines || "（无）"}\n\n[正文摘要]\n${parsed.body}`;
      } catch (e) {
        return fail(
          `页面快照失败: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  };

  const navigate: ToolDefinition<{ url: string }> = {
    name: "browser_navigate",
    description: "导航会话浏览器页到新地址（http/https）",
    parameters: z.object({ url: z.string().describe("目标地址") }),
    kind: "read",
    execute: async (ctx, { url }) => {
      const bad = assertUrl(url);
      if (bad) return fail(bad);
      const control = resolve(ctx.sessionId);
      if (!control) return fail(NO_TAB);
      try {
        await control.loadURL(url);
        return `已导航到 ${url}，可再调用 browser_snapshot 读取新页面`;
      } catch (e) {
        return fail(`导航失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };

  const click: ToolDefinition<{ idx: number }> = {
    name: "browser_click",
    description: "点击快照序号对应元素；页面刷新后序号失效需重新快照",
    parameters: z.object({
      idx: z.number().int().describe("快照里的元素序号"),
    }),
    kind: "write",
    execute: async (ctx, { idx }) => {
      const control = resolve(ctx.sessionId);
      if (!control) return fail(NO_TAB);
      try {
        const out = await control.executeJavaScript(clickScript(idx));
        if (out === "NOT_FOUND")
          return fail("元素不存在（页面可能已变化）——请重新 browser_snapshot");
        return String(out);
      } catch (e) {
        return fail(`点击失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };

  const type: ToolDefinition<{ idx: number; text: string }> = {
    name: "browser_type",
    description: "填入文本到快照序号对应的输入框",
    parameters: z.object({
      idx: z.number().int().describe("快照里的输入框序号"),
      text: z.string().describe("要输入的文本"),
    }),
    kind: "write",
    execute: async (ctx, { idx, text }) => {
      const control = resolve(ctx.sessionId);
      if (!control) return fail(NO_TAB);
      try {
        const out = await control.executeJavaScript(typeScript(idx, text));
        if (out === "NOT_FOUND")
          return fail("元素不存在（页面可能已变化）——请重新 browser_snapshot");
        return `已在序号 ${idx} 输入文本`;
      } catch (e) {
        return fail(`输入失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };

  return [snapshot, navigate, click, type];
}

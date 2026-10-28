import { create } from "zustand";
import {
  ENDPOINTS,
  type ChatStreamChunk,
  type SessionReadResult,
} from "@tianshu/protocol";

import { activeTransport } from "./connections.store";
import { useSessionsStore } from "./sessions.store";
import { getNotifyPrefs } from "./notify.store";
import { notifyLocal } from "../lib/notify";
import { parseBlocks, type MessageBlock } from "../logic/blocks";
import { buildOptimisticUserMessage } from "../logic/optimistic-user-message";
import i18n from "../i18n";
import {
  applyRemoteChunk,
  failRemoteStream,
  idleRemoteStream,
  startRemoteStream,
  type RemoteStreamState,
} from "../logic/remote-stream";
import type { TransportRequestResult } from "../transport/types";

/**
 * 会话流状态（T14）：history（getById 定稿，blocks 已 parse）+ live
 * （remote-stream 归并中的流式块）+ sending（send 202 受理至 finish/error
 * 收尾）。定稿语义取简：finish/error chunk 后重拉 getById 覆写 history、
 * live 重置——服务端消息行为唯一真值（桌面端 react-query invalidate 同构）。
 */

/** 渲染态消息（getById 消息行经 parseBlocks 后形态；blocks 为数组） */
export interface ChatMessage {
  id: number;
  role: "user" | "assistant" | "system";
  blocks: MessageBlock[];
  /** getById 消息行创建时间（ISO——微信范式时间分隔；旧被控端缺省 undefined） */
  createdAt?: string;
  /** 生成该条 assistant 消息的模型行 id（CU 批 wire 透传；user/旧端缺省
   *  undefined——B5 消息元信息「模型名」展示数据源） */
  modelId?: number;
  /** 生成耗时毫秒（durationMs 批 wire 透传；user 行/旧端缺省 undefined
   *  ——消息元信息「耗时」展示数据源） */
  durationMs?: number;
}

export interface SessionStreamState {
  history: ChatMessage[];
  live: RemoteStreamState;
  /** send 202 受理后 true；finish/error chunk、session.error、受理失败 false */
  sending: boolean;
  /** loadHistory 请求进行中（首屏 loading 态） */
  loading: boolean;
  /** 拉取失败（仅在尚无可渲染历史时展示） */
  loadError: boolean;
  /** 最近一轮流错误文案（"" = 网络层无信息，UI 兜底文案）；下次 startSend 清 */
  error: string | null;
  /** getById 的 session.title（页面标题） */
  sessionTitle: string | null;
  /** getById 的 session.workspaceId（LT-T4 文件引用——files/list 入参） */
  sessionWorkspaceId: number | null;
  /** getById 的 session.mode 三值收窄（MT-T3 模式胶囊初始态；缺省 agent） */
  sessionMode: "agent" | "ask" | "plan";
  /** getById 的 session.currentModelId（模型胶囊初始态——服务端记住的
   *  上次选择；选中即 session/update 写回，重进不再重选） */
  sessionModelId: number | null;
  /** A9 compact 批：getById 的 session.summary（压缩摘要——非空时会话页
   *  出压缩提示条；旧被控端无此字段 = null 不展示） */
  sessionSummary: string | null;
}

interface StreamState {
  bySession: Record<number, SessionStreamState>;
  /** getById 全量拉取：history 覆写；非 sending 态下 live 重置（定稿收口） */
  loadHistory(sessionId: number): Promise<void>;
  /** 乐观用户消息 + send 受理；返回是否受理成功（失败已回滚乐观消息）。
   *  MB-T1 images：选图 base64 暂存——发送时逐张 files/uploadImage 得
   *  imagePath 随 send 上行（单图失败跳过不阻断）；渲染侧 MessageImage
   *  经 image 端点回读，闭环零改 */
  startSend(
    sessionId: number,
    content: string,
    modelId?: number,
    images?: Array<{ name: string; base64: string }>,
    /** MT-T2：请求级专家覆盖（sessionSend 参数——写回会话当前值） */
    assistantId?: number,
  ): Promise<boolean>;
  /** 末条 assistant 原位重跑（MB-T3）：受理即置流态，chunk 链收口 */
  regenerate(sessionId: number): Promise<boolean>;
  /** 编辑重发（LT-T2）：改写 user 消息 + 截断其后 + 原位重跑——本地
   *  history 先行乐观（改写该 user 轮文本、截断其后），失败回滚置错 */
  editAndResend(
    sessionId: number,
    messageId: number,
    content: string,
  ): Promise<boolean>;
  /** message.chunk 事件分发（finish/error 收尾并触发定稿重拉） */
  applyChunk(sessionId: number, chunk: ChatStreamChunk): void;
  /** session.error 事件：置错收尾（不重拉——被拒轮次服务端不落库） */
  applySessionError(sessionId: number, message: string): void;
  /** 断线收口（fix1）：transport 掉线后 finish/error chunk 无期，置错解锁 */
  handleTransportDown(sessionId: number, message: string): void;
  /** 中止当前流：请求即发不等回包（finish chunk 兜底解锁 sending） */
  abort(sessionId: number): void;
  /** 卸载清理：退场即弃（流未收尾时再进按 getById 重建） */
  clear(sessionId: number): void;
}

/** wire 消息行（getById messages[]：blocks 为协议 JSON 字符串） */
type WireMessage = {
  id?: unknown;
  role?: unknown;
  blocks?: unknown;
  createdAt?: unknown;
  modelId?: unknown;
  durationMs?: unknown;
};

/** wire 判别：id/role/blocks 齐备才收，blocks 字符串 parseBlocks 容错 */
function toChatMessages(rows: unknown): ChatMessage[] {
  if (!Array.isArray(rows)) return [];
  const out: ChatMessage[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const m = row as WireMessage;
    if (
      typeof m.id !== "number" ||
      (m.role !== "user" && m.role !== "assistant" && m.role !== "system") ||
      typeof m.blocks !== "string"
    ) {
      continue;
    }
    out.push({
      id: m.id,
      role: m.role,
      blocks: parseBlocks(m.blocks),
      ...(typeof m.createdAt === "string" ? { createdAt: m.createdAt } : {}),
      ...(typeof m.modelId === "number" ? { modelId: m.modelId } : {}),
      ...(typeof m.durationMs === "number" ? { durationMs: m.durationMs } : {}),
    });
  }
  return out;
}

/** wire 判别结果：null message = 网络层异常/无信息（调用方 UI 兜底文案） */
type WireOk = { ok: true; data: unknown } | { ok: false; message: string };

/** 统一请求出口（sessions.store 同款契约：HTTP 200 亦可能业务错，判 body.success） */
async function request(path: string, body: unknown): Promise<WireOk> {
  const transport = activeTransport();
  if (!transport) return { ok: false, message: "" };
  try {
    const result: TransportRequestResult = await transport.request(
      "POST",
      path,
      body,
    );
    if (typeof result.body !== "object" || result.body === null) {
      return { ok: false, message: "" };
    }
    const b = result.body as {
      success?: unknown;
      data?: unknown;
      message?: unknown;
    };
    if (b.success !== true) {
      return {
        ok: false,
        message: typeof b.message === "string" ? b.message : "",
      };
    }
    return { ok: true, data: b.data ?? null };
  } catch {
    return { ok: false, message: "" }; // 网络层异常：流未受理，由调用方回滚
  }
}

function blankSession(): SessionStreamState {
  return {
    history: [],
    live: idleRemoteStream(),
    sending: false,
    loading: false,
    loadError: false,
    error: null,
    sessionTitle: null,
    sessionWorkspaceId: null,
    sessionMode: "agent",
    sessionModelId: null,
    sessionSummary: null,
  };
}

/** loadHistory 时序令牌：迟到的旧响应/清理后响应不得覆写（按会话隔离） */
const historySeq = new Map<number, number>();

/** P1 未读角标批：已读上报——成功 loadHistory 后由调用方以真实消息 max(id)
 *  触发（路由跳转/mount 盲报不可：空历史无真实 id、请求可能失败、须以
 *  拉到的真值消息 id 为准）。失败静默不改本地已读（下次 loadHistory 重报）；
 *  成功响应经迟到旧响应过滤后同步会话列表角标（服务端 read 后亦发
 *  session.updated，双通道同口径幂等）。
 *  迟到旧响应判定基线取 store 现 history 的 max(id)——并发在途 read 响应
 *  乱序到达时，旧游标响应不得回滚已读角标（服务端单调推进只保证库内游标
 *  不回退，不保证响应到达序）；history 已清（会话卸载）则不过滤 */
async function reportSessionRead(
  sessionId: number,
  messageId: number,
): Promise<void> {
  const r = await request(ENDPOINTS.session.read, { sessionId, messageId });
  if (!r.ok) return;
  const d = (r.data ?? {}) as Partial<SessionReadResult> | null;
  if (
    typeof d?.sessionId !== "number" ||
    typeof d.lastReadMessageId !== "number" ||
    typeof d.unreadCount !== "number"
  ) {
    return;
  }
  const history = useStreamStore.getState().bySession[sessionId]?.history;
  if (history) {
    const knownMax = history.reduce((m, x) => Math.max(m, x.id), 0);
    if (d.lastReadMessageId < knownMax) return;
  }
  useSessionsStore.getState().applyRead(d.sessionId, d.unreadCount);
}

function bumpSeq(sessionId: number): number {
  const token = (historySeq.get(sessionId) ?? 0) + 1;
  historySeq.set(sessionId, token);
  return token;
}

export const useStreamStore = create<StreamState>((set, get) => {
  /** 局部覆写单会话条目（entry 缺席按 blank 起底） */
  function patch(sessionId: number, part: Partial<SessionStreamState>): void {
    set((s) => ({
      bySession: {
        ...s.bySession,
        [sessionId]: { ...(s.bySession[sessionId] ?? blankSession()), ...part },
      },
    }));
  }

  return {
    bySession: {},

    loadHistory: async (sessionId) => {
      const token = bumpSeq(sessionId);
      patch(sessionId, { loading: true, loadError: false });
      const r = await request(ENDPOINTS.session.getById, { id: sessionId });
      if ((historySeq.get(sessionId) ?? 0) !== token) return;
      if (!r.ok) {
        // 已有可渲染历史不闪错（下拉/重进场景）；空表才标记失败供重试
        const had = (get().bySession[sessionId]?.history.length ?? 0) > 0;
        patch(sessionId, { loading: false, loadError: !had });
        return;
      }
      const d = (r.data ?? {}) as { session?: unknown; messages?: unknown };
      const sess =
        typeof d.session === "object" && d.session !== null
          ? (d.session as { title?: unknown })
          : null;
      const prev = get().bySession[sessionId] ?? blankSession();
      const messages = toChatMessages(d.messages);
      patch(sessionId, {
        loading: false,
        loadError: false,
        history: messages,
        sessionTitle:
          sess && typeof sess.title === "string" ? sess.title : null,
        sessionWorkspaceId:
          sess &&
          typeof (sess as { workspaceId?: unknown }).workspaceId === "number"
            ? (sess as { workspaceId: number }).workspaceId
            : null,
        sessionMode:
          (sess as { mode?: unknown } | null)?.mode === "ask" ||
          (sess as { mode?: unknown } | null)?.mode === "plan"
            ? (sess as { mode: "ask" | "plan" }).mode
            : "agent",
        sessionModelId:
          sess != null &&
          typeof (sess as { currentModelId?: unknown }).currentModelId ===
            "number"
            ? (sess as { currentModelId: number }).currentModelId
            : null,
        sessionSummary:
          sess != null &&
          typeof (sess as { summary?: unknown }).summary === "string"
            ? ((sess as { summary: string }).summary ?? null)
            : null,
        // sending 中不重置流态（挂载期竞态：send 先于首拉返回，乐观消息/
        // chunk 流以本地为准）；定稿重拉（sending 已 false）自然收口 live
        ...(prev.sending ? {} : { live: idleRemoteStream(), sending: false }),
      });
      // P1 未读角标批：成功拉取后以真实消息 max(id) 上报已读（乐观负 id
      //  不参与；空历史无真实 id 不报）——停留期间 finish 定稿重拉覆盖新
      //  消息即由此清角标
      const maxRealId = messages.reduce(
        (m, x) => (x.id > 0 ? Math.max(m, x.id) : m),
        0,
      );
      if (maxRealId > 0) {
        void reportSessionRead(sessionId, maxRealId);
      }
    },

    startSend: async (sessionId, content, modelId, images, assistantId) => {
      // MB-T1：发送时上传（选图仅暂存——弃发不浪费）。图片引用不正常
      // （任一上传失败/回包畸形）即阻断发送（裁定 2026-10-21：明确图片
      // 正常才发文本，不剔图发纯文）——置错返回 false，调用方保留输入
      // 与暂存图供删图重试
      const imagePaths: string[] = [];
      let uploadFailed = 0;
      let firstReason = "";
      for (const image of images ?? []) {
        const up = await request(ENDPOINTS.files.uploadImage, image);
        if (up.ok) {
          const path = (up.data as { imagePath?: unknown } | null)?.imagePath;
          if (typeof path === "string") {
            imagePaths.push(path);
            continue;
          }
        }
        uploadFailed += 1;
        // 失败原因透传（业务错 message 非空——「图片超过 3MB 上限」等；
        // 网络层/超时为空，调用方兜底文案）——真机定位上传失败必需
        if (firstReason === "" && !up.ok && up.message !== "") {
          firstReason = up.message;
        }
      }
      if (uploadFailed > 0) {
        const detail = firstReason !== "" ? `：${firstReason}` : "";
        set((s) => ({
          bySession: {
            ...s.bySession,
            [sessionId]: {
              ...(s.bySession[sessionId] ?? blankSession()),
              error: `${i18n.t("chat:imageUploadFailed", { count: uploadFailed })}${detail}`,
            },
          },
        }));
        return false;
      }
      const optimistic = buildOptimisticUserMessage(sessionId, content);
      const entry = get().bySession[sessionId] ?? blankSession();
      set((s) => ({
        bySession: {
          ...s.bySession,
          [sessionId]: {
            ...entry,
            history: [
              ...entry.history,
              {
                id: optimistic.id,
                role: optimistic.role,
                blocks: parseBlocks(optimistic.blocks),
              },
            ],
            live: startRemoteStream(),
            sending: true,
            error: null,
          },
        },
      }));
      const r = await request(ENDPOINTS.session.send, {
        sessionId,
        content,
        ...(modelId != null ? { modelId } : {}),
        ...(assistantId != null ? { assistantId } : {}),
        ...(imagePaths.length > 0 ? { images: imagePaths } : {}),
      });
      if (r.ok) return true;
      // 受理失败回滚：乐观消息撤回、流态置错、解锁（errorMessage 供 UI 展示）
      const after = get().bySession[sessionId];
      if (after) {
        set((s) => ({
          bySession: {
            ...s.bySession,
            [sessionId]: {
              ...after,
              history: after.history.filter((m) => m.id !== optimistic.id),
              live: failRemoteStream(after.live, r.message),
              sending: false,
              error: r.message,
            },
          },
        }));
      }
      return false;
    },

    applyChunk: (sessionId, chunk) => {
      const entry = get().bySession[sessionId];
      if (!entry) return; // 未打开会话（含已 clear）：迟到 chunk 丢弃
      // 新审批（队列中尚无同 toolCallId）→ 后台本地通知（M3）；同 id 重发
      // 仅刷新摘要（enqueueApproval 语义），不重复打扰。live.active 门
      // （M4）：idle 条目（未发送/流已收尾）上的迟到审批 chunk 不通知
      // ——与 UI 展示对齐（applyRemoteChunk 对 inactive 流本就忽略）
      if (
        chunk.type === "approval-request" &&
        entry.live.active &&
        !entry.live.approvals.some((a) => a.toolCallId === chunk.toolCallId)
      ) {
        const prefs = getNotifyPrefs();
        if (prefs.enabled && prefs.approvals) {
          notifyLocal({
            title: i18n.t("notify:approvalTitle"),
            body: `${chunk.toolName}`,
          });
        }
      }
      const terminal = chunk.type === "finish" || chunk.type === "error";
      set((s) => ({
        bySession: {
          ...s.bySession,
          [sessionId]: {
            ...entry,
            live: applyRemoteChunk(entry.live, chunk),
            sending: terminal ? false : entry.sending,
            // error 收尾：error chunk 置文案、finish 清残留（前轮失败不再悬挂）
            error:
              chunk.type === "error"
                ? chunk.message
                : chunk.type === "finish"
                  ? null
                  : entry.error,
          },
        },
      }));
      if (terminal) {
        void get().loadHistory(sessionId); // 定稿重拉：history 覆写 + live 重置
      }
    },

    applySessionError: (sessionId, message) => {
      const entry = get().bySession[sessionId];
      if (!entry) return;
      set((s) => ({
        bySession: {
          ...s.bySession,
          [sessionId]: {
            ...entry,
            // 乐观消息是假的：CONCURRENT_REQUEST/SESSION_NOT_FOUND/ARCHIVED
            // 均在用户消息落库前抛（chat.service send 时序——守卫先于
            // appendMessage），被拒轮次滤除（与 startSend 回滚对齐）
            history: entry.history.filter((m) => m.id >= 0),
            live: failRemoteStream(entry.live, message),
            sending: false,
            error: message,
          },
        },
      }));
    },

    handleTransportDown: (sessionId, message) => {
      const entry = get().bySession[sessionId];
      // 非发送态无锁可解：不覆写既有 error/live（防无关掉线污染展示）
      if (!entry || !entry.sending) return;
      set((s) => ({
        bySession: {
          ...s.bySession,
          [sessionId]: {
            ...entry,
            // 乐观消息保留：send 已 202 受理、用户消息大概率已落库，
            // 重连（server.connected → loadHistory）重拉对齐真值
            live: failRemoteStream(entry.live, message),
            sending: false,
            error: message,
          },
        },
      }));
    },

    abort: (sessionId) => {
      const transport = activeTransport();
      if (!transport) return;
      void transport
        .request("POST", ENDPOINTS.session.abort, { sessionId })
        .catch(() => {
          /* 静默：finish chunk 兜底解锁 sending（chat.stop 受理即视为已中止） */
        });
    },

    editAndResend: async (sessionId, messageId, content) => {
      // LT-T2：乐观改写（该 user 轮 text 换新文、截断其后），受理失败
      // 回滚（loadHistory 定稿重拉兜底——error 置位提示）
      const before = get().bySession[sessionId];
      const snapshot = before ? before.history.map((m) => ({ ...m })) : null;
      set((s) => {
        const cur = s.bySession[sessionId];
        if (!cur) return s;
        const idx = cur.history.findIndex((m) => m.id === messageId);
        if (idx === -1) return s;
        const rewritten = cur.history.slice(0, idx + 1).map((m, i) =>
          i === idx
            ? {
                ...m,
                blocks: [{ type: "text", text: content }] as MessageBlock[],
              }
            : m,
        );
        return {
          bySession: {
            ...s.bySession,
            [sessionId]: {
              ...cur,
              history: rewritten,
              live: startRemoteStream(),
              sending: true,
              error: null,
            },
          },
        };
      });
      const r = await request(ENDPOINTS.session.editAndResend, {
        sessionId,
        messageId,
        content,
      });
      if (r.ok) return true;
      set((s) => {
        const cur = s.bySession[sessionId];
        if (!cur) return s;
        return {
          bySession: {
            ...s.bySession,
            [sessionId]: {
              ...cur,
              history: snapshot ?? cur.history,
              live: idleRemoteStream(),
              sending: false,
              error: r.message !== "" ? r.message : null,
            },
          },
        };
      });
      return false;
    },

    regenerate: async (sessionId) => {
      // MB-T3：受理即置流态（末条 assistant 原位重跑——messageId 缺省
      // 语义）；finish/error chunk 既有链收口 + 定稿重拉
      const entry = get().bySession[sessionId];
      if (entry?.sending) return false;
      set((s) => {
        const cur = s.bySession[sessionId];
        if (!cur) return s;
        return {
          bySession: {
            ...s.bySession,
            [sessionId]: {
              ...cur,
              live: startRemoteStream(),
              sending: true,
              error: null,
            },
          },
        };
      });
      const r = await request(ENDPOINTS.session.regenerate, { sessionId });
      if (r.ok) return true;
      // 受理失败回滚流态并置错
      set((s) => {
        const cur = s.bySession[sessionId];
        if (!cur) return s;
        return {
          bySession: {
            ...s.bySession,
            [sessionId]: {
              ...cur,
              live: idleRemoteStream(),
              sending: false,
              error: r.message !== "" ? r.message : null,
            },
          },
        };
      });
      return false;
    },

    clear: (sessionId) => {
      bumpSeq(sessionId); // 在途 loadHistory 迟到响应作废
      set((s) => {
        const bySession = { ...s.bySession };
        delete bySession[sessionId];
        return { bySession };
      });
    },
  };
});

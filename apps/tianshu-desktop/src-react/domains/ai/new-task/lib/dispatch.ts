/**
 * 新建任务发送编排（spec §3.2）：读 store 草稿 → 敏感词/工作空间前置校验 →
 * 逐 pending 引用组注入块（file 工作空间引用式——仅路径+read 指示 /
 * localFile 本地文件读内容 / skill 技能读内容，注入格式与 ChatView 发送层
 * 同口径 buildInjectedContent）→ create(scenario)
 * → [专家/模式/模型草稿落库（PlusMenu 对齐）：setAssistant / setMode /
 * setModel（send 前完成，失败降级继续）] →
 * [full: setPermission] → send（发起即继续不等流结束）→ 清草稿跳会话。
 * create/读引用失败抛错（调用方 NewTaskView catch 后 toast）草稿保留落地页；
 * send 例外——session 已建立仅早期失败 toast，仍导航
 */
import i18n from "@/i18n";
import { toast } from "sonner";

import SessionApi from "../../api/session.api";
import ChatApi from "../../api/chat.api";
import SkillApi from "../../skills/api/skill.api";
import { mapIpcError } from "../../chat/lib/error-message";
import { buildInjectedContent } from "../../chat/lib/build-injected-content";
import { type PendingFile, splitImageFiles } from "../../chat/lib/pending-file";
import { isImagePath } from "../../chat/lib/image-file";
import { readExternalFile } from "./attach";
import { checkSensitive } from "./sensitive-check";
import type { PendingRef } from "../store/new-task-store";
import { useNewTaskStore } from "../store/new-task-store";

export interface DispatchParams {
  navigate: (to: string, options?: { replace?: boolean }) => void;
}

/** 单条 pending 引用 → 注入块（读失败直接抛错中断本次发送——落地页逐引用可用才可发） */
async function readPendingRef(ref: PendingRef): Promise<PendingFile> {
  if (ref.kind === "skill") {
    const result = await SkillApi.readSkill(ref.ref);
    return { path: ref.ref, content: result.content, kind: "skill" };
  }
  if (ref.kind === "localFile") {
    // 图片附件不读内容：分流为多模态 image part（主进程侧校验/落块）
    if (isImagePath(ref.ref)) {
      return { path: ref.ref, content: "", kind: "localFile", image: true };
    }
    const result = await readExternalFile(ref.ref);
    return {
      path: ref.ref,
      content: result.content ?? "",
      kind: "localFile",
    };
  }
  // 引用式（引用式批 2026-10-21）：工作空间引用不读全文——新会话默认
  // agent 模式，AI 处理时 read 自读（面板只显示路径行），对齐主聊天
  // ChatInput 引用式口径；原「读失败即中断发送」的预检随之取消（文件
  // 失效由 AI 工具读取时报错反馈，与主聊天一致）
  return { path: ref.ref, content: "", kind: "fileRef" };
}

/** 读取 store 当前草稿并发起任务；任一步失败抛错（调用方 toast），输入保留 */
export async function dispatchNewTask({
  navigate,
}: DispatchParams): Promise<void> {
  const {
    content,
    scenario,
    workspaceId,
    accessMode,
    pending,
    mode,
    assistantId,
    modelId,
  } = useNewTaskStore.getState();
  if (workspaceId === null) {
    throw new Error("no-workspace");
  }
  const hit = checkSensitive(content);
  if (hit) {
    throw new Error(`sensitive:${hit}`);
  }
  const files = await Promise.all(pending.map((ref) => readPendingRef(ref)));
  // 图片附件分流（与 ChatPane.handleSend 同口径）：不进文本注入，随消息
  // 走多模态 image part
  const { textFiles, images } = splitImageFiles(files);
  const created = await SessionApi.create({ workspaceId, scenario });
  // + 菜单草稿落库（PlusMenu 对齐）：专家/模式选中态写到新建 session；
  // 默认值（无专家/agent）跳过——create 默认即该值，省两次 IPC
  if (assistantId !== null) {
    await SessionApi.setAssistant(created.id, assistantId);
  }
  if (mode !== "agent") {
    await SessionApi.setMode(created.id, mode);
  }
  // 模型草稿落库必须在 send 之前：chat:send 为 fire-and-forget，起流时
  // 读 session 模型；失败降级继续（session 已建，中断会产生孤儿会话，
  // 改用后端默认模型发送并 toast）
  if (modelId !== null) {
    try {
      await SessionApi.setModel(created.id, modelId);
    } catch (e) {
      toast.error(mapDispatchError(e));
    }
  }
  if (accessMode === "full") {
    await ChatApi.setPermission(created.id, "full");
  }
  // chat:send 的 IPC 契约是"整个流式生成完成才 resolve"（后端 send 内部
  // await streamAndPersist）——落地页发起即继续、不等流：ChatView 挂载后经
  // chat:status/流事件恢复进度；早期失败（无模型等，发生在流开始前）在此
  // toast，流内错误由 ChatView 错误块展示（与 ChatInput 发送同口径）
  ChatApi.send({
    sessionId: created.id,
    content: buildInjectedContent(content, textFiles),
    images,
  }).catch((e) => {
    toast.error(mapDispatchError(e));
  });
  useNewTaskStore.getState().resetDraft();
  navigate(`/module/ai?session=${created.id}`, { replace: true });
}

/**
 * dispatch 抛错 → toast 文案：无空间/敏感词/读失败映射 newTask 词条，
 * 其余沿用 IPC 码表映射（chat:errors.*）/原样透传
 */
export function mapDispatchError(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  if (message === "no-workspace") {
    return i18n.t("newTask:context.noWorkspace");
  }
  if (message.startsWith("sensitive:")) {
    return i18n.t("newTask:sensitiveHit", {
      word: message.slice("sensitive:".length),
    });
  }
  return mapIpcError(e);
}

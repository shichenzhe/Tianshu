/**
 * 关闭确认桥（tab 菜单深层入口 ↔ FileWindowView 确认浮层，Task 15）：
 * 确认状态机（CloseConfirmBar + confirming state）在视图层，注册表桥接
 * 模式同 tab-save-flush（draft 受控在内容区、flush 注册表外取）。
 * confirmBeforeClose/resolveTabClosures 复用 spec §4.4 逐 dirty tab 确认
 * 语义：activate 前置（冲突条渲染在其内容区）→ save=flush 后校验（未存
 * 成留窗）/ discard=直接放行 / cancel=中止；未注册 asker 时 discard 放行
 * （非文件窗渲染环境兜底）。
 */
import type { CloseConfirmAnswer } from "../components/CloseConfirmBar";
import {
  useFileWindowStore,
  type FileWindowTab,
} from "../store/file-window.store";
import { flushTabSave } from "./tab-save-flush";

type ConfirmAsker = (tab: FileWindowTab) => Promise<CloseConfirmAnswer>;

let asker: ConfirmAsker | null = null;

export function registerCloseConfirmAsk(fn: ConfirmAsker): void {
  asker = fn;
}

export function unregisterCloseConfirmAsk(): void {
  asker = null;
}

function askCloseConfirm(tab: FileWindowTab): Promise<CloseConfirmAnswer> {
  return asker ? asker(tab) : Promise.resolve("discard");
}

/**
 * 单 tab 关闭前置确认：非脏直接放行；脏走确认（save=注册表保存流后校验
 * 仍脏则 onSaveFailed + 拒绝）。不在此关 tab——「关」与「移到新窗口」共用
 * 同一前置，落子由调用方决定。
 */
export async function confirmBeforeClose(
  tabId: string,
  onSaveFailed?: () => void,
): Promise<boolean> {
  const store = useFileWindowStore.getState();
  const tab = store.tabs.find((x) => x.id === tabId);
  if (!tab) return false;
  if (!tab.dirty) return true;
  // 前置激活：确认浮层下该 tab 就位（保存冲突条渲染在其内容区）
  useFileWindowStore.getState().activate(tabId);
  const answer = await askCloseConfirm(tab);
  if (answer === "cancel") return false;
  if (answer === "save") {
    await flushTabSave(tabId);
    const after = useFileWindowStore
      .getState()
      .tabs.find((x) => x.id === tabId);
    if (after?.dirty) {
      // 冲突等未存成——留窗交冲突条；onSaveFailed 兜底 toast（保存流内
      // 多为 mapIpcError 细粒度文案，此处盖住静默取消）
      onSaveFailed?.();
      return false;
    }
  }
  return true;
}

/**
 * 批量关闭：逐 tab 顺序处理（脏确认队列语义）——非脏按 closeCleanTabs
 * 决定是否直接关（窗口关闭流程只裁决脏 tab、非脏随窗走；tab 菜单关闭
 * 其他/右侧则非脏直接关）；脏走 confirmBeforeClose 后关；任一取消即
 * 中止（后续保持原状）。
 */
export async function resolveTabClosures(
  tabIds: string[],
  closeCleanTabs: boolean,
  onSaveFailed?: () => void,
): Promise<"ok" | "cancelled"> {
  for (const tabId of tabIds) {
    const tab = useFileWindowStore.getState().tabs.find((x) => x.id === tabId);
    if (!tab) continue;
    if (!tab.dirty) {
      if (closeCleanTabs) useFileWindowStore.getState().closeTab(tabId);
      continue;
    }
    const ok = await confirmBeforeClose(tabId, onSaveFailed);
    if (!ok) return "cancelled";
    useFileWindowStore.getState().closeTab(tabId);
  }
  return "ok";
}

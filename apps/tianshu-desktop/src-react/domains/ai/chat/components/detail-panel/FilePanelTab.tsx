/**
 * 右栏文件 tab（WorkBuddy 对齐）：工作空间文件树/产物列表点击文件 →
 * DetailPanel.openFileTab 开独立 kind="file" tab（同路径复用由其保证），
 * 内容复用 FilePreview 预览该文件。tab 形态无「返回列表」语义——省略
 * onBack 即不渲染 FilePreview 头部返回按钮；关闭预览 = 关 tab。
 * 「在新窗口打开」移动语义：FilePreview 开独立文件窗成功后回调关本
 * 主窗 tab（sessionId/tabId 由 DetailPanel 渲染处透传，store getState
 * 直读防过期闭包）。
 */
import FilePreview from "../artifacts/FilePreview";
import type { SessionFile } from "../../lib/artifacts";
import { useDetailPanelStore } from "../../store/detail-panel.store";

interface FilePanelTabProps {
  workspaceId: number;
  /** 工作空间内相对路径（tab 负载同源） */
  filePath: string;
  /** 主窗会话 id（「在新窗口打开」后关 tab 用） */
  sessionId: number;
  /** 主窗 file tab id（同上） */
  tabId: string;
}

export default function FilePanelTab({
  workspaceId,
  filePath,
  sessionId,
  tabId,
}: FilePanelTabProps) {
  // 构造 SessionFile：group/workspace/status 仅满足形状，FilePreview 只
  // 消费 path（读取模式判定/查询 key/reveal 均按 path + workspaceId）
  const file: SessionFile = {
    path: filePath,
    group: "workspace",
    status: "written",
    messageId: 0,
  };
  return (
    <div className="h-full min-h-0">
      <FilePreview
        file={file}
        workspaceId={workspaceId}
        onOpenInNewWindow={() =>
          useDetailPanelStore.getState().closeTab(sessionId, tabId)
        }
      />
    </div>
  );
}

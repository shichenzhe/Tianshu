/**
 * 会话右栏（tab 式，参照 WorkBuddy detailPanel）：tab 条 +「+」新标签页
 * 占位 tab + 内容区路由。外壳（340px 列宽/左边框/TopBar 宽度注册/收起
 * 整体移除）沿袭原 ArtifactsPanel 语义；产物内容瘦身为 ArtifactsTab。
 * tab 状态 sessionId 隔离（detail-panel.store）；内容区渲染当前会话
 * 全部 tab（display 隐藏非 active——webview/xterm 常驻保状态，切会话
 * 卸载由 store 负载恢复 url/terminalId）。
 * 「+」/T（WorkBuddy 对齐）：直接开 kind=newTab 占位 tab，内容页
 * NewTabPagePanel 列选项，点选项原位替换为所选类型。
 * 最大化（R25）：tab 条尾部按钮/Esc 切换 ai-ui panelMaximized，外层
 * 转 fixed inset-0 全窗覆盖（z-[60] 层级与弹层关系见 ui/dialog.tsx）；
 * tab 条贴顶（R24）与红绿灯垂直对齐（R27）：行容器 h-11（44px）+
 * items-center，tab 高 h-7 不变居中——按钮中心 y=22 与 mac 红绿灯
 *（main.ts trafficLightPosition y=16、钮径约 12px → 中心 22）同水平
 * 线；行高取 TopBar h-11 同款，Windows titleBarOverlay 高 44 恰合。
 * 穿透 TopBar（R26）：正常态面板本体同样 fixed 顶到窗口顶，盖掉 TopBar
 * 右段 44px 空带——tab 条贴 y=0（理由与裁剪实测见 return 处注释）。
 */
import {
  useCallback,
  useEffect,
  useId,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Maximize2, Minimize2, Plus } from "lucide-react";
import IconTooltip from "@/components/common/icon-tooltip";
import type { WorkspaceRecord } from "../../../api/workspace.api";
import { Button } from "@/components/ui/button";
import { useAiUiStore } from "../../../store/ai-ui.store";
import {
  useDetailPanelStore,
  type DetailTabKind,
} from "../../store/detail-panel.store";
import ArtifactsTab from "../artifacts/ArtifactsPanel";
import BrowserPanelTab from "./BrowserPanelTab";
import ChangesPanelTab from "./ChangesPanelTab";
import DetailTabBar from "./DetailTabBar";
import FilePanelTab from "./FilePanelTab";
import NewTabPagePanel from "./NewTabPagePanel";
import TerminalTab from "./TerminalTab";
import WorkspaceFileTree from "./WorkspaceFileTree";

/** Electron 无边框窗口拖拽区域样式（React CSSProperties 未内置该属性） */
type AppRegionStyle = CSSProperties & { WebkitAppRegion?: string };

interface DetailPanelProps {
  sessionId: number;
  workspaceId: number;
  /** 当前会话完整空间记录（项目资产会话拿不到时为 null → 绑定引导空态） */
  workspace: WorkspaceRecord | null;
  topSection?: ReactNode;
}

export default function DetailPanel({
  sessionId,
  workspaceId,
  workspace,
  topSection,
}: DetailPanelProps) {
  const { t } = useTranslation(["chat"]);
  const state = useDetailPanelStore((s) => s.panels[sessionId]);
  const openTab = useDetailPanelStore((s) => s.openTab);
  const closeTab = useDetailPanelStore((s) => s.closeTab);
  const setActive = useDetailPanelStore((s) => s.setActive);
  const reorderTab = useDetailPanelStore((s) => s.reorderTab);
  const syncTab = useDetailPanelStore((s) => s.syncTab);
  const panelMaximized = useAiUiStore((s) => s.panelMaximized);
  const setPanelMaximized = useAiUiStore((s) => s.setPanelMaximized);
  const isMac = window.platform === "darwin";

  // 顶部工具栏右段宽度注册（原 ArtifactsPanel 语义原样迁移）：340 与本
  // 面板列宽 w-[340px] 同步维护
  const panelId = useId();
  useEffect(() => {
    useAiUiStore.getState().registerTopbarRightWidth(panelId, 340);
    return () => useAiUiStore.getState().unregisterTopbarRightWidth(panelId);
  }, [panelId]);

  // 打开右栏无 tabs 自动初始化产物 tab（spec §3）；依赖 [sessionId] 覆盖
  // 「面板开着切会话」；getStateOf 直读防过期闭包；length 守卫挡 StrictMode 双跑
  useEffect(() => {
    if (useDetailPanelStore.getStateOf(sessionId).tabs.length === 0) {
      openTab(sessionId, "artifacts", t("chat:detailPanel.artifacts"));
    }
  }, [sessionId, t]);

  const tabs = state?.tabs ?? [];
  const activeTabId = state?.activeTabId ?? "";

  // useCallback：键盘快捷键 effect 依赖（引用稳定防重复注册，同 handleClose）
  const handleOpen = useCallback(
    (kind: DetailTabKind) => {
      openTab(sessionId, kind, t(`chat:detailPanel.${kind}`));
    },
    [openTab, sessionId, t],
  );

  // useCallback：键盘快捷键 effect 依赖 handleClose（引用稳定防重复注册）
  const handleClose = useCallback(
    (tabId: string) => {
      // 终端 tab：先显式 kill pty（切会话卸载不 kill，仅关闭时杀）
      const tab = tabs.find((item) => item.id === tabId);
      if (tab?.terminalId) {
        window.ipcRenderer?.send("terminal:kill", tab.terminalId);
      }
      closeTab(sessionId, tabId);
    },
    [closeTab, sessionId, tabs],
  );

  // 打开文件 tab（WorkBuddy 对齐）：工作空间树/产物列表点击文件 → 开
  // kind="file" tab（标题=basename）；同路径已有 file tab 复用激活不重开
  // （参照 openBrowser 联动复用语义）。getStateOf 直读防过期闭包（同桥）
  const handleOpenFile = useCallback(
    (filePath: string) => {
      const existing = useDetailPanelStore
        .getStateOf(sessionId)
        .tabs.find((tab) => tab.kind === "file" && tab.filePath === filePath);
      if (existing) {
        setActive(sessionId, existing.id);
        return;
      }
      const basename = filePath.split("/").pop() || filePath;
      openTab(sessionId, "file", basename);
      const created = useDetailPanelStore.getStateOf(sessionId).tabs.at(-1);
      if (created) syncTab(sessionId, created.id, { filePath });
    },
    [openTab, setActive, syncTab, sessionId],
  );

  // 快捷键：T 开新标签页占位 tab / W 关当前（焦点在输入框或带修饰键时
  // 忽略）；Esc 退出最大化（R25，先于聚焦守卫——输入框内 Esc 同样可退出）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 长按连发（e.repeat）统一挡在守卫链首：W 会连环关 tab，T 虽幂等一并挡
      if (e.repeat) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        // 直读防过期闭包（同 openTab 初始化 effect 口径）：只退出不进入
        if (useAiUiStore.getState().panelMaximized) {
          setPanelMaximized(false);
        }
        return;
      }
      const el = document.activeElement;
      const tag = el?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      // isContentEditable 在 HTMLElement（activeElement 类型是 Element），
      // instanceof 收窄
      if (el instanceof HTMLElement && el.isContentEditable) return;
      if (e.key === "t" || e.key === "T") {
        e.preventDefault();
        handleOpen("newTab");
      } else if (e.key === "w" || e.key === "W") {
        if (activeTabId) {
          e.preventDefault();
          handleClose(activeTabId);
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [activeTabId, handleClose, handleOpen, setPanelMaximized]);

  const maxLabel = panelMaximized
    ? t("chat:detailPanel.restore")
    : t("chat:detailPanel.maximize");

  return (
    // 挤压式右列：wrapper 仅占位（w-[340px] shrink-0，收起时由外层整体
    // 移除），左列挤压语义不变；面板本体 fixed 顶到窗口顶——穿透 TopBar
    // 右段 44px 空带（R26：tab 条贴 y=0，WorkBuddy detailPanel 同形态）。
    // 为何 fixed 而非 -mt-11 负边距上移：MainLayout 链 .main-content
    // overflow:hidden 与 main overflow-y-auto 双重裁剪，负边距越出部分
    // 被剪掉不可见（2026-10-14 实测：shell 布局在 y=0 但 elementFromPoint
    // 命中 TopBar 右段容器，tab 不可见）；fixed 的 containing block 是
    // 视口，天然逃逸裁剪（R25 最大化同理）。
    // 不动 TopBar：右段背景（data-topbar-right-bg）还被项目详情右栏等
    // 页面共用；右段宽度注册（340）保留——TopBar 中段内容避让仍需要。
    // z-[55] 盖过 TopBar z-50（最大化 z-[60] 不变）；外层显式 no-drag：
    // TopBar 44px drag 区不遵循 z-index 覆盖，贴顶 tab 条落在其中会被
    // 吞掉鼠标事件，zIndex 内联双保险。代价：body portal 的弹层
    // （DropdownMenu/Popover/Select 默认 z-50）会被本层盖住——弹层族
    // 已全局提 z-[75]、Dialog/AlertDialog 模态层 z-[70]，层级表见
    // ui/dialog.tsx 头注释
    <div className="w-[340px] shrink-0">
      <div
        data-detail-panel=""
        className={
          panelMaximized
            ? "fixed inset-0 z-[60] flex flex-col bg-background"
            : "fixed right-0 top-0 z-[55] h-full w-[340px] flex flex-col border-l border-border/50 bg-background"
        }
        style={
          panelMaximized
            ? ({ zIndex: 60, WebkitAppRegion: "no-drag" } as AppRegionStyle)
            : ({ zIndex: 55, WebkitAppRegion: "no-drag" } as AppRegionStyle)
        }
      >
        {/* 贴顶 tab 条（R24 穿透 + R27 红绿灯对齐）：tab pill 直贴窗口
            顶 y=0，TopBar 右段空带已被本层盖住；行容器 h-11 items-center
            使按钮中心 y=22 与 mac 红绿灯中心同水平线（trafficLightPosition
            y=16 + 钮径/2 ≈ 22），行高取 TopBar h-11 同款；tab h-7 不变。
            最大化态 macOS 让出红绿灯区域（pl-20 让位口径不变）；
            Windows/Linux 让出原生窗口按钮区：titleBarOverlay（main.ts，
            非 darwin 恒有，高 44 与本行 h-11 对齐）绘制在 web 内容
            之上，tab 条行尾「+」/放大按钮正落其下——照抄 TopBar 右段
            既有占位口径（pr-2 + w-[138px] 控制区 = 146px，TopBar L128-137） */}
        <div
          className={`flex h-11 items-center gap-1 border-b border-border/50 px-2 ${
            panelMaximized && isMac ? "pl-20" : ""
          } ${!isMac ? "pr-[146px]" : ""}`}
        >
          <DetailTabBar
            tabs={tabs}
            activeTabId={activeTabId}
            onSelect={(tabId) => setActive(sessionId, tabId)}
            onClose={handleClose}
            onReorder={(fromId, toId) => reorderTab(sessionId, fromId, toId)}
          />
          {/* 「+」直开「新标签页」占位 tab（WorkBuddy 形态，原 DropdownMenu
              菜单废弃）：选项列表在占位 tab 内容页 NewTabPagePanel，点选项
              原地替换本 tab；样式口径照两侧 ghost 按钮（h-7 w-7 muted→primary） */}
          <IconTooltip label={t("chat:detailPanel.newTab")}>
            <Button
              variant="ghost"
              size="sm"
              aria-label={t("chat:detailPanel.newTab")}
              onClick={() => handleOpen("newTab")}
              className="h-7 w-7 shrink-0 p-0 text-muted-foreground hover:text-primary"
            >
              <Plus className="h-4 w-4" />
            </Button>
          </IconTooltip>
          {/* 放大/还原（R25）：tab 条尾部，口径照 ArtifactsPanelToggle
            （h-7 w-7 ghost + muted→primary），ml-auto 推至行尾 */}
          <IconTooltip label={maxLabel}>
            <Button
              variant="ghost"
              size="sm"
              aria-label={maxLabel}
              aria-pressed={panelMaximized}
              onClick={() => setPanelMaximized(!panelMaximized)}
              className="ml-auto h-7 w-7 shrink-0 p-0 text-muted-foreground hover:text-primary"
            >
              {panelMaximized ? (
                <Minimize2 className="h-4 w-4" />
              ) : (
                <Maximize2 className="h-4 w-4" />
              )}
            </Button>
          </IconTooltip>
        </div>
        <div className="min-h-0 flex-1">
          {tabs.map((tab) => {
            const active = tab.id === activeTabId;
            const style = { display: active ? "flex" : "none" };
            return (
              <div
                key={tab.id}
                className="flex h-full min-h-0 flex-col"
                style={style}
              >
                {tab.kind === "artifacts" ? (
                  <ArtifactsTab
                    sessionId={sessionId}
                    workspaceId={workspaceId}
                    topSection={topSection}
                    onOpenFile={handleOpenFile}
                  />
                ) : tab.kind === "browser" ? (
                  <BrowserPanelTab
                    sessionId={sessionId}
                    tab={tab}
                    isActive={active}
                  />
                ) : tab.kind === "workspace" ? (
                  workspace ? (
                    // key=空间 id：切会话换空间时重挂（树展开/缓存属空间
                    // 快照，残留会显示旧空间目录）；点文件开独立 file tab
                    <WorkspaceFileTree
                      key={workspace.id}
                      workspace={workspace}
                      onOpenFile={handleOpenFile}
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                      {t("chat:detailPanel.workspaceBindHint")}
                    </div>
                  )
                ) : tab.kind === "file" ? (
                  // file tab 由列表点击打开（handleOpenFile 同路径复用）；
                  // filePath 空为异常防御（正常 openTab+syncTab 原子成对）；
                  // sessionId/tabId 供「在新窗口打开」移动语义关本 tab
                  tab.filePath ? (
                    <FilePanelTab
                      workspaceId={workspaceId}
                      filePath={tab.filePath}
                      sessionId={sessionId}
                      tabId={tab.id}
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                      {t("chat:detailPanel.fileTabMissing")}
                    </div>
                  )
                ) : tab.kind === "changes" ? (
                  workspace ? (
                    // key=空间 id：照 workspace 分支先例，切会话换空间重挂
                    // （diffOf 快照属空间，残留会显示旧空间 diff）
                    <ChangesPanelTab key={workspace.id} workspace={workspace} />
                  ) : (
                    <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                      {t("chat:detailPanel.workspaceBindHint")}
                    </div>
                  )
                ) : tab.kind === "newTab" ? (
                  // 占位 tab 内容页：key=tab.id，replaceTab 换 id 即重挂
                  <NewTabPagePanel
                    sessionId={sessionId}
                    tabId={tab.id}
                    workspace={workspace}
                  />
                ) : (
                  <TerminalTab
                    sessionId={sessionId}
                    tab={tab}
                    isActive={active}
                    cwd={workspace?.directoryPath ?? ""}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

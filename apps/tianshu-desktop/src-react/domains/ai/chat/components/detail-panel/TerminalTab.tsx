/**
 * 终端 tab：@xterm/xterm + fit addon。terminalId 存 DetailTab 负载——
 * 切会话卸载重挂后按负载续连：pty 存活续流，重挂经 terminal:replay 回放
 * cap 内输出（spec §3 修正：裸重挂新 xterm 空缓冲 + 空闲 shell 不重画
 * 提示符 = 空白）；先探活（terminal:probe），pty 已在挂起窗口退出则直接
 * 显示退出态 + 重新打开（换新 terminalId）。主题取 CSS 变量 --color-*
 * （Tailwind 4，值可为任意 CSS 颜色函数），data-mode（明暗）/data-theme
 * （四色）变更即时刷新。
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { RotateCw, SquareTerminal } from "lucide-react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { on } from "@/lib/ipc";
import TerminalApi from "@/domains/ai/terminal/api/terminal.api";
import { mapIpcError } from "../../lib/error-message";
import {
  useDetailPanelStore,
  type DetailTab,
} from "../../store/detail-panel.store";

interface TerminalTabProps {
  sessionId: number;
  tab: DetailTab;
  isActive: boolean;
  cwd: string;
}

/** 读主题 CSS 变量：值形如 hsl(...)/oklch(...) 直接用，空值回落 */
function cssColor(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

/** 终端配色快照：实例构造与主题切换刷新同源（skin.store 写 data-mode/data-theme） */
function readTheme(): ITheme {
  return {
    background: cssColor("--color-background", "#1f1f1f"),
    foreground: cssColor("--color-foreground", "#cccccc"),
    cursor: cssColor("--color-primary", "#22cba8"),
    selectionBackground: cssColor("--color-primary", "#22cba8"),
  };
}

export default function TerminalTab({
  sessionId,
  tab,
  isActive,
  cwd,
}: TerminalTabProps) {
  const { t } = useTranslation(["chat"]);
  const syncTab = useDetailPanelStore((s) => s.syncTab);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [terminalId, setTerminalId] = useState<string | null>(
    tab.terminalId ?? null,
  );
  const [exited, setExited] = useState(false);
  const [failed, setFailed] = useState(false);

  // 续连探活（spec deferred）：pty 在挂起窗口退出时重挂即显示退出态，
  // 不空转发 write；重开换新 id 后由创建 effect 回写负载（旧 id 不复活）
  useEffect(() => {
    if (terminalId === null || exited) return;
    let cancelled = false;
    TerminalApi.probe(terminalId)
      .then((alive) => {
        if (!cancelled && !alive) setExited(true);
      })
      .catch(() => {
        /* 探活失败按原续连语义走，不阻塞 */
      });
    return () => {
      cancelled = true;
    };
  }, [terminalId, exited]);

  // 创建（或按负载续连）+ xterm 实例 + 事件订阅：terminalId 生命周期内一次
  useEffect(() => {
    const container = containerRef.current;
    if (!container || terminalId === null || exited) return;

    const term = new Terminal({
      fontFamily:
        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 12,
      cursorBlink: true,
      theme: readTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    try {
      fit.fit();
    } catch {
      // 容器尺寸为 0（隐藏 tab）忽略，激活时 refit
    }
    termRef.current = term;
    fitRef.current = fit;

    // 重挂回放握手：监听先挂 → replay 快照写入 → 此后实时数据直写。
    // ack 前到达的实时数据丢弃而非 flush——主进程 onData「push 缓冲 + send」
    // 原子、同 webContents IPC FIFO，故 replay 应答前到达的事件必已含于快照
    // （flush 会重复写脏渲染；若 FIFO 假设失效，兜底 = 改为缓存后 flush）
    let acked = false;
    let disposed = false;
    const offData = on(`terminal:data:${terminalId}`, (_event, data) => {
      if (typeof data === "string" && acked) term.write(data);
    });
    const offExit = on(`terminal:exit:${terminalId}`, () => setExited(true));
    TerminalApi.replay(terminalId)
      .then((text) => {
        if (disposed) return;
        acked = true;
        term.write(text);
      })
      .catch(() => {
        // 会话已不存在（kill/pty 退出）：转退出态（语义对齐 probe=false）；
        // 若 exit 事件已先行触发 setExited，此处幂等
        if (!disposed) setExited(true);
      });
    const resizeObserver = new ResizeObserver(() => {
      try {
        fit.fit();
        TerminalApi.resize(terminalId, term.cols, term.rows);
      } catch {
        // 隐藏时 fit 抛错忽略
      }
    });
    resizeObserver.observe(container);
    term.onData((data) => TerminalApi.write(terminalId, data));

    // 主题跟随：data-mode（明暗）/data-theme（四色 hue）变化重读 CSS 变量
    // （skin.store.applySkin 写 documentElement；运行时更新 options.theme 官方支持）
    const themeObserver = new MutationObserver(() => {
      term.options.theme = readTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-mode", "data-theme"],
    });

    return () => {
      disposed = true;
      themeObserver.disconnect();
      resizeObserver.disconnect();
      offData();
      offExit();
      term.dispose();
      termRef.current = null;
    };
  }, [terminalId, exited]);

  // 首次进入：无负载则创建 pty 并回写负载（failed 入守卫/依赖——失败态
  // reopen 置 failed=false 触发重试；失败瞬间 effect 空转由守卫挡住）
  useEffect(() => {
    if (terminalId !== null || exited || failed) return;
    let cancelled = false;
    TerminalApi.create(cwd)
      .then((id) => {
        if (cancelled) {
          TerminalApi.kill(id);
          return;
        }
        setTerminalId(id);
        syncTab(sessionId, tab.id, { terminalId: id });
      })
      .catch((e) => {
        if (!cancelled) {
          setFailed(true);
          toast.error(
            `${t("chat:detailPanel.terminalCreateFailed")}: ${mapIpcError(e)}`,
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [terminalId, exited, failed, cwd, sessionId, tab.id, syncTab, t]);

  // tab 激活时 refit（隐藏期容器尺寸变化不触发 observer 的场景兜底）
  useEffect(() => {
    if (isActive && fitRef.current) {
      try {
        fitRef.current.fit();
        if (terminalId) {
          TerminalApi.resize(
            terminalId,
            termRef.current?.cols ?? 80,
            termRef.current?.rows ?? 24,
          );
        }
      } catch {
        // 忽略
      }
    }
  }, [isActive, terminalId]);

  const reopen = () => {
    setExited(false);
    setFailed(false);
    setTerminalId(null); // 触发创建 effect 换新 id
  };

  if (failed || exited) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <SquareTerminal className="h-8 w-8" />
        <p className="text-xs">
          {failed
            ? t("chat:detailPanel.terminalCreateFailed")
            : t("chat:detailPanel.terminalExited")}
        </p>
        <button
          type="button"
          onClick={reopen}
          className="inline-flex items-center gap-1 rounded-md border border-border/50 px-2 py-1 text-xs hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
        >
          <RotateCw className="h-3.5 w-3.5" />
          {t("chat:detailPanel.terminalReopen")}
        </button>
      </div>
    );
  }

  return <div ref={containerRef} className="h-full min-h-0 w-full p-1" />;
}

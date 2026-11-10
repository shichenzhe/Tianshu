/**
 * 主机态跨窗口同步（webview 批 2026-11-11）：文件独立窗口与主窗是两个
 * renderer——host.store 各持一份内存态，文件窗无 HostSwitcher 恒落本地
 * 兜底，远程主机下打开的 library 条目在文件窗内必 miss（此前远程读链
 * 形同虚设）。同步走 localStorage 快照 + storage 事件（同源双窗天然
 * 共享；storage 事件只在「其他」窗口触发——主窗写、文件窗收，无回环）：
 * - 主窗侧：switchToHost 切换后 publishActiveHost 落快照（单写点——
 *   store.switchHost 保持纯态不沾存储）
 * - 文件窗侧：FileWindowView 挂载 initFileWindowHostSync——初值应用 +
 *   storage 事件跟随（主窗切主机，文件窗打开着的 tab 随之换数据源；
 *   kick/caps 回填语义对齐 switchToHost）。主窗自身不读初值：应用重启
 *   主窗仍从本地起步（既有语义不变），快照只服务后开的文件窗。
 */
import {
  useHostStore,
  capsOfCapabilities,
  isSameHost,
  type ActiveHost,
} from "./host.store";
import ServerApi from "../server/api/server.api";

/** localStorage 快照键（与 tianshu-locale 同前缀命名法） */
const ACTIVE_HOST_KEY = "tianshu-active-host";

/** 快照解析：形状校验失败/损坏返回 null（宁缺毋滥——落本地兜底） */
function parseHost(raw: string | null): ActiveHost | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { kind?: unknown; connId?: unknown };
    if (v.kind === "local") return { kind: "local" };
    if (v.kind === "remote" && typeof v.connId === "string") {
      return { kind: "remote", connId: v.connId };
    }
  } catch {
    // 损坏快照——本地兜底
  }
  return null;
}

/** 主窗侧落快照（switchToHost 单写点；写失败静默——同步是尽力而为） */
export function publishActiveHost(host: ActiveHost): void {
  try {
    localStorage.setItem(ACTIVE_HOST_KEY, JSON.stringify(host));
  } catch {
    // 私密模式/配额——文件窗退化本地态，主流程不受影响
  }
}

/**
 * 文件窗侧引导：初值应用 + storage 事件跟随主窗切换。
 * @param deps kickQueries 与 switchToHost 同语义（切前 reset 活动查询）
 * @returns 退订函数（FileWindowView 卸载即解除）
 */
export function initFileWindowHostSync(deps: {
  kickQueries: () => void;
}): () => void {
  const apply = (host: ActiveHost) => {
    const store = useHostStore.getState();
    if (isSameHost(store.activeHost, host)) {
      return;
    }
    deps.kickQueries();
    store.switchHost(host);
    if (host.kind === "remote") {
      // caps 回填：连接注册表运行时上报（同 switchToHost；连接已由主窗
      // 建链——文件窗只读注册表，无激活副作用）
      ServerApi.listConnections()
        .then(({ connections }) => {
          const conn = connections.find((c) => c.id === host.connId);
          useHostStore.setState({
            caps: capsOfCapabilities(conn?.capabilities ?? []),
          });
        })
        .catch(() => {
          // 注册表暂不可达——保持空面（后续切换事件会再回填）
        });
    }
  };
  apply(parseHost(localStorage.getItem(ACTIVE_HOST_KEY)) ?? { kind: "local" });
  const onStorage = (e: StorageEvent) => {
    if (e.key !== ACTIVE_HOST_KEY) return;
    const host = parseHost(e.newValue);
    if (host) apply(host);
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}

/** 测试面：直接派发 storage 事件（jsdom 不跨实例联动） */
export const dispatchHostStorageForTest = (host: ActiveHost) => {
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: ACTIVE_HOST_KEY,
      newValue: JSON.stringify(host),
    }),
  );
};

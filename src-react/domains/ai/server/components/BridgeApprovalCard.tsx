/**
 * 桌面工具桥审批卡（TB-T2，spec §4.2）：主进程 bridge-executor 的 write 门
 * （browser_click/browser_type）推送 server:bridgeApproval → 本卡渲染工具
 * 名/参数摘要/允许/拒绝 → 应答走 server:bridgeDecision INVOKE：
 * - resolved=true（命中消费）→ 卡收起（执行/拒绝在主进程收敛并 respond）
 * - resolved=false（超时先收敛/他端竞速）→ stale 态锁按键 + 手动收起
 * - 通道错误 → toast 报错不锁，可重试
 * 挂载于 ServerConsoleView 顶部（多卡栈列；载荷渲染层复核类型双保险——
 * 拒绝为默认安全态，超时同拒，均在主进程收敛）。
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Check, Loader2, ShieldAlert, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import ServerApi, {
  onBridgeApproval,
  type BridgeApprovalPayload,
} from "../api/server.api";
import { describeError } from "../lib/describe-error";

interface ApprovalState {
  payload: BridgeApprovalPayload;
  busy: boolean;
  stale: boolean;
}

/** 参数摘要：args JSON 文本化截断（tool-gate summarizeArgs 同口径） */
function describeArgs(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args).slice(0, 100);
  } catch {
    return "";
  }
}

/** 载荷形状复核（主进程已校验；渲染层防回归双保险）。sessionId 两态：
 * 会话桥调用为 number，图执行发起为 null（2026-10-28 去会话化——协议
 * ToolRequestPayload.sessionId 可空）——显式判空保持「键必须在场且值
 * 合法」的复核强度，缺键/undefined 仍拒 */
function isBridgePayload(raw: unknown): raw is BridgeApprovalPayload {
  const p = raw as BridgeApprovalPayload | null;
  return (
    typeof p?.requestId === "string" &&
    typeof p?.tool === "string" &&
    (p?.sessionId === null || typeof p?.sessionId === "number") &&
    typeof p?.args === "object" &&
    p.args !== null
  );
}

export default function BridgeApprovalCard() {
  const { t } = useTranslation(["ai"]);
  const [items, setItems] = useState<ApprovalState[]>([]);

  useEffect(() => {
    return onBridgeApproval((payload) => {
      if (!isBridgePayload(payload)) return;
      setItems((prev) =>
        prev.some((item) => item.payload.requestId === payload.requestId)
          ? prev
          : [...prev, { payload, busy: false, stale: false }],
      );
    });
  }, []);

  const patch = (requestId: string, next: Partial<ApprovalState>) => {
    setItems((prev) =>
      prev.map((item) =>
        item.payload.requestId === requestId ? { ...item, ...next } : item,
      ),
    );
  };

  const remove = (requestId: string) => {
    setItems((prev) =>
      prev.filter((item) => item.payload.requestId !== requestId),
    );
  };

  const respond = async (item: ApprovalState, approved: boolean) => {
    if (item.busy || item.stale) return;
    patch(item.payload.requestId, { busy: true });
    try {
      const resolved = await ServerApi.bridgeDecision(
        item.payload.requestId,
        approved,
      );
      if (resolved) {
        remove(item.payload.requestId);
      } else {
        patch(item.payload.requestId, { stale: true, busy: false });
      }
    } catch (e) {
      toast.error(t("ai:server.bridge.failed", { message: describeError(e) }));
      patch(item.payload.requestId, { busy: false });
    }
  };

  if (items.length === 0) return null;

  return (
    <div data-testid="bridge-approval-stack" className="space-y-2 p-3">
      {items.map((item) => (
        <div
          key={item.payload.requestId}
          data-testid="bridge-approval-card"
          className="flex flex-col gap-1.5 rounded-md border border-primary/30 bg-primary-subtle/40 px-3 py-2 shadow-lg"
        >
          <div className="flex items-center gap-1.5">
            <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-amber-500" />
            <span className="text-xs font-medium text-foreground">
              {t("ai:server.bridge.approvalTitle")}
              <span className="ml-1 font-mono text-foreground/80">
                {item.payload.tool}
              </span>
            </span>
          </div>
          <p className="break-words font-mono text-xs text-muted-foreground">
            {describeArgs(item.payload.args) ||
              t("ai:server.bridge.approvalFallback")}
          </p>
          {item.stale ? (
            <div className="flex items-center justify-between">
              <p
                data-testid="bridge-approval-stale"
                className="text-xs text-amber-500"
              >
                {t("ai:server.bridge.stale")}
              </p>
              <Button
                variant="outline"
                size="sm"
                data-testid="bridge-approval-dismiss"
                className="h-6 px-2 text-xs hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
                onClick={() => remove(item.payload.requestId)}
              >
                {t("ai:server.bridge.dismiss")}
              </Button>
            </div>
          ) : (
            <div className="mt-0.5 flex items-center gap-2">
              <Button
                variant="default"
                size="sm"
                data-testid="bridge-approve"
                disabled={item.busy}
                onClick={() => void respond(item, true)}
              >
                {item.busy ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="mr-1 h-3.5 w-3.5" />
                )}
                {t("ai:server.bridge.approve")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                data-testid="bridge-reject"
                className="hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
                disabled={item.busy}
                onClick={() => void respond(item, false)}
              >
                <X className="mr-1 h-3.5 w-3.5" />
                {t("ai:server.bridge.reject")}
              </Button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

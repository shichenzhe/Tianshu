import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ENDPOINTS } from "@tianshu/protocol";
import { Pressable, Text } from "react-native";
import { ShieldCheck, ShieldQuestion } from "lucide-react-native";

import { useThemeColors } from "@/store/theme";
import { wireRequest } from "@/transport/wire";

/**
 * 会话工具权限胶囊（LT-T3，对齐桌面 PermissionCapsule）：default
 * 高危询问（网络域/文件写入/常用命令直执行——真值在被控端
 * tool-gate，权限放宽 2026-10-24）/ full 放行——挂载 get
 * （session/accessMode mode 缺省查询），点击切换 set；失败静默保持
 * 原态（下次进入重查）。被控端旧版本无此端点时（业务错）胶囊
 * 隐藏——不阻断会话页。
 */
export function PermissionChip({ sessionId }: { sessionId: number }) {
  const { t } = useTranslation("chat");
  const colors = useThemeColors();
  const [mode, setMode] = useState<"default" | "full" | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await wireRequest("POST", ENDPOINTS.session.accessMode, {
        sessionId,
      });
      if (cancelled || !r.ok) return;
      const next = (r.data as { mode?: unknown } | null)?.mode;
      if (next === "default" || next === "full") {
        setMode(next);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const toggle = useCallback(async () => {
    if (mode == null) return;
    const next = mode === "default" ? "full" : "default";
    // 乐观切换；失败回滚（静默——胶囊态仅展示，权限真值在服务端）
    setMode(next);
    const r = await wireRequest("POST", ENDPOINTS.session.accessMode, {
      sessionId,
      mode: next,
    });
    const echoed = r.ok
      ? (r.data as { mode?: unknown } | null)?.mode
      : undefined;
    if (echoed !== "default" && echoed !== "full") {
      setMode(mode);
    }
  }, [mode, sessionId]);

  if (mode == null) {
    return null; // 端点不可用/未就绪——不占位
  }

  const full = mode === "full";
  return (
    <Pressable
      onPress={() => void toggle()}
      hitSlop={6}
      className="flex-row items-center gap-1 rounded-md px-1.5 py-1"
      style={{ backgroundColor: full ? colors.subtle : "transparent" }}
      accessibilityLabel={t(full ? "permFull" : "permDefault")}
    >
      {full ? (
        <ShieldCheck size={13} color={colors.primary} />
      ) : (
        <ShieldQuestion size={13} color="#8E8E93" />
      )}
      <Text
        className="text-[10px]"
        style={{ color: full ? colors.primary : "#8E8E93" }}
      >
        {t(full ? "permFull" : "permDefault")}
      </Text>
    </Pressable>
  );
}

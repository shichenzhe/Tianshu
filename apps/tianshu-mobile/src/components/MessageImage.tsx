import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Image } from "expo-image";
import { ActivityIndicator, Modal, Pressable, Text } from "react-native";
import { Image as ImageIcon } from "lucide-react-native";

import type { ImageBlock } from "@/logic/blocks";
import { fileRefBasename } from "@/logic/file-refs";
import { useConnectionsStore } from "@/store/connections.store";
import { useThemeColors } from "@/store/theme";
import type { WireResult } from "@/transport/wire";

/**
 * 消息图片（T15；2026-10-24 参照形态改版）：ImageBlock 不再在消息流内拉
 * 大图——渲染为文件名 chip（图标 + 展示名），点击才弹 Modal 全屏查看。
 * 拉图经 POST image 取 {mime, dataBase64} 拼 data URL。模块级缓存以
 * 「连接 id:imagePath」为键（fix round 1：同 path 跨连接是不同被控端的
 * 不同文件，切连接后不得命中旧 base64）；在途 Promise 同键去重（同图
 * 多实例并发挂载单飞）。
 * 真机修复 2026-10-24——expo-image 原生解码链（RN Image iOS 对 data URI
 * 大图静默不渲染）；拉图走专用 60s fetch 通道——通用 request 的 15s abort
 * 管道对大图 base64 JSON 读体超时（expo/fetch 原生桥大响应慢，getById
 * 小包毫秒级通过、image 大包超时——「文本正常图片全挂」根因）。chip 化
 * 后默认零网络请求（真机滚动消息列表不再批量拉图），点开才走该通道。
 */

const imageCache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

/** 缓存条目上限（M4）：超限清最旧——Map 迭代序=插入序，删首个即 FIFO
 * 淘汰（简单 LRU 免实现：命中不续位，最久拉取的先走） */
const IMAGE_CACHE_MAX = 30;

/** 写缓存并按上限淘汰最旧一条 */
function cacheImage(cacheKey: string, url: string): void {
  imageCache.set(cacheKey, url);
  if (imageCache.size > IMAGE_CACHE_MAX) {
    const oldest = imageCache.keys().next().value;
    if (oldest !== undefined) imageCache.delete(oldest);
  }
}

/** 活动连接配置（拉图专用通道用）：connections store 的 configs/activeConnId */
function activeFaceTarget(): { baseUrl: string; token: string } | null {
  const { configs, activeConnId } = useConnectionsStore.getState();
  const cfg = configs.find((c) => c.id === activeConnId);
  return cfg && cfg.mode === "direct" && cfg.baseUrl && cfg.token
    ? { baseUrl: cfg.baseUrl, token: cfg.token }
    : null;
}

/** 拉图专用通道（真机修复 2026-10-24）：大图 base64 JSON 在通用 request
 *  的 15s abort 管道下读体超时（expo/fetch 原生桥大响应慢）——绕开
 *  wireRequest，RN 内建 fetch + 60s 超时自行解包 {code,success,data}；
 *  token 走 query 口径（face 鉴权 Bearer/query 双收）。仅 direct 模式
 *  （relay 4MiB 单帧限制本就传不动大图，回退失败占位行为不劣化） */
async function fetchImageJson(imagePath: string): Promise<WireResult | null> {
  const target = activeFaceTarget();
  if (target == null) return null;
  const timeoutAbort = new AbortController();
  const timer = setTimeout(() => timeoutAbort.abort(), 60_000);
  try {
    const res = await globalThis.fetch(
      `${target.baseUrl}/image?token=${encodeURIComponent(target.token)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: imagePath }),
        signal: timeoutAbort.signal,
      },
    );
    const body: unknown = await res.json();
    const b = body as { code?: unknown; success?: unknown; data?: unknown } | null;
    if (res.status !== 200 || b?.success !== true) return null;
    return { ok: true, data: b.data ?? null };
  } catch {
    return null; // 网络/超时/坏 JSON：失败占位（含 60s 超时兜底）
  } finally {
    clearTimeout(timer);
  }
}

/** 拉图并缓存；失败（业务错 4040/网络层）返回 null 走占位 */
async function loadImage(cacheKey: string, imagePath: string): Promise<string | null> {
  const cached = imageCache.get(cacheKey);
  if (cached) return cached;
  const pending = inflight.get(cacheKey);
  if (pending) return pending;
  const task = (async () => {
    // 拉图专用通道（60s 超时，见 fetchImageJson）：绕开通用 request 的
    // 15s abort 管道——大图 base64 JSON 读体在 expo/fetch 原生桥下慢
    const r = await fetchImageJson(imagePath);
    if (!r || !r.ok) return null;
    const d = r.data as { mime?: unknown; dataBase64?: unknown } | null;
    if (
      typeof d !== "object" ||
      d === null ||
      typeof d.mime !== "string" ||
      typeof d.dataBase64 !== "string"
    ) {
      return null;
    }
    const url = `data:${d.mime};base64,${d.dataBase64}`;
    cacheImage(cacheKey, url);
    return url;
  })();
  inflight.set(cacheKey, task);
  try {
    return await task;
  } finally {
    inflight.delete(cacheKey);
  }
}

/** 消息图片 chip（参照桌面 2026-10-24 对齐批）：文件名小标签零网络渲染，
 *  点击弹黑底 Modal 全屏查看——点开才拉图（lazy：spinner → 大图/失败文案） */
export function MessageImage({ block }: { block: ImageBlock }) {
  const { t } = useTranslation("chat");
  const colors = useThemeColors();
  const activeConnId = useConnectionsStore((s) => s.activeConnId);
  // 缓存键带连接维度：未激活连接归 "none"（无 transport 拉取必失败走
  // 占位，不与真实连接的缓存互串）
  const cacheKey = `${activeConnId ?? "none"}:${block.imagePath}`;
  const label = block.name ?? fileRefBasename(block.imagePath);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [uri, setUri] = useState<string | null>(() =>
    imageCache.get(cacheKey) ?? null,
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!zoomOpen) return;
    let cancelled = false;
    // 键变（切换连接）时先按缓存重置再拉取：旧连接的 uri 不残留展示
    const cached = imageCache.get(cacheKey) ?? null;
    setUri(cached);
    setFailed(false);
    if (cached) return;
    void loadImage(cacheKey, block.imagePath).then((url) => {
      if (cancelled) return;
      if (url) setUri(url);
      else setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [zoomOpen, cacheKey, block.imagePath]);

  return (
    <>
      <Pressable
        onPress={() => setZoomOpen(true)}
        accessibilityLabel={t("imageZoom", { name: label })}
        className="mb-1 mr-1.5 self-start flex-row items-center gap-1 rounded-md border border-sep bg-white/60 px-2 py-1 dark:border-[#545458A6] dark:bg-[#2C2C2E]"
        style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
      >
        <ImageIcon size={12} color={colors.primary} />
        <Text
          numberOfLines={1}
          className="max-w-[160px] text-xs text-label2 dark:text-[#EBEBF599]"
        >
          {label}
        </Text>
      </Pressable>
      <Modal
        visible={zoomOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setZoomOpen(false)}
      >
        <Pressable
          className="flex-1 items-center justify-center bg-black/90"
          onPress={() => setZoomOpen(false)}
        >
          {uri ? (
            <Image
              source={{ uri }}
              style={{ width: "92%", height: "70%" }}
              contentFit="contain"
              transition={120}
            />
          ) : failed ? (
            <Text className="text-xs text-white/60">{t("imageFailed")}</Text>
          ) : (
            <ActivityIndicator size="small" color="#8E8E93" />
          )}
        </Pressable>
      </Modal>
    </>
  );
}

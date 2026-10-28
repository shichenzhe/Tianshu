# 聊天导出批接线 + 二档单选 UI 恢复计划（2026-10-24）

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。步骤用 checkbox 跟踪。

**Goal:** 恢复前批（reset 事故丢失）的两块工作：A) 聊天导出批的宿主接线（幸存 9 文件已入库 `8e55e19f`，自带 17 测试全过）；B) PermissionCapsule 二档单选 UI 重建。

**Spec:** 无独立 spec（恢复既定设计；权限语义 spec 见 `2026-10-24-permission-relax-design.md`，文案基准见其 §4.8）。

## Global Constraints
- 与权限放宽批同：双引号+分号、i18n 双语、禁 lint 用 prettier+vitest、`git add` 显式路径、`--no-verify`、共享树改完即 commit
- 桌面 MessageImage 现为其它会话维护的形态——接线**适配当前组件**，不回改其它会话的 chip 化设计
- 幸存文件 API 为唯一事实源（不重写它们，只挂接）

---

### Task A: 聊天导出批接线（mirror 前后端）

**幸存 API 清单（已入库，勿改）：**
- 主进程纯函数 `electron/domains/ai/chat/media-export.ts`：`parseImageDataUrl(dataUrl)` / `sanitizeSaveName(name, ext)` / `saveImageDataUrl(dataUrl, filePath)`（注释明确：调用方负责 showSaveDialog；mime 白名单 png/jpeg/webp/gif、10MB 上限）
- 渲染层 `src-react/lib/data-url.ts`：`dataUrlToBlob` / `copyImageToClipboard`（W3C 剪贴板；BrowserToolbar 内联版收编目标）
- `src-react/domains/ai/chat/lib/mermaid-export.ts`：`svgToPngDataUrl` / `svgIntrinsicSize` / `fitExportScale` / `PNG_EXPORT_SCALE`
- 组件 `src-react/domains/ai/chat/components/MermaidBlock.tsx`（151 行，自包含：渲染+复制/下载按钮，内部消费 mermaid-export 与 hooks）
- hooks：`use-color-mode.ts`（`ColorMode`/`useColorMode`）、`use-copy-text.ts`（`useCopyText`）

**Files:**
- Modify: `electron/domains/ai/chat/chat.service.ts`（两个 handleUser handler + import）
- Modify: `electron/commons/ipc-channels.ts`（照该文件惯例登记通道，若有类型联合）
- Modify: `src-react/domains/ai/api/chat.api.ts`（渲染层 invoke 封装：`saveImageFile(dataUrl, defaultName): Promise<string|null>`、`captureWidget(rect): Promise<string>`，照该文件既有 api 惯例）
- Modify: `src-react/domains/ai/chat/components/MarkdownView.tsx`（mermaid 语言代码块 → MermaidBlock 分支）
- Modify: `src-react/domains/ai/chat/components/CodeBlock.tsx`（复制按钮接 useCopyText；代码文本下载走原生 Blob+<a> 纯渲染层，不经主进程）
- Modify: `src-react/domains/ai/chat/components/MessageImage.tsx`（图片操作：复制 `copyImageToClipboard` + 另存 `saveImageFile`——按当前组件形态挂工具按钮，lightbox/浮层均可）
- Modify: `src-react/domains/ai/chat/components/MessageFileRef.tsx`（文件引用导出：内容 Blob 下载纯渲染层，按该组件现有数据可得性设计）
- Modify: `src-react/domains/ai/chat/components/WidgetRenderer.tsx`（widget 图表区截图：iframe `getBoundingClientRect()`（DIP）→ `captureWidget(rect)` → 复制/另存；iframe 内滚动仅可视区为协议限制，注释注明）
- Modify: `src-react/domains/ai/chat/components/artifacts/FilePreview.tsx`（预览下载按钮：文件 Blob 下载或图片走 saveImageFile，按现有数据类型分支）
- Modify: `src-react/domains/ai/browser/components/BrowserToolbar.tsx`（内联 dataUrlToBlob 若有 → 收编 import 共享件）
- Modify: `src-react/domains/ai/chat/lib/error-message.ts`（新增导出失败错误分类映射，按该文件既有模式）
- Test: handler 单测（新增 `tests/ai/chat/save-dataurl.test.ts`——mock electron dialog：取消→null、确认→写盘路径；invalid 入参抛 IMAGE_DATAURL_INVALID）+ 适配 `tests/ai/code-block.test.tsx`、`tests/ai/widget-renderer.test.tsx`（新按钮断言）

**chat.service.ts handler 规格（前批 diff 原文，照抄）：**
```ts
// 聊天输出便捷导出批：dataUrl 图片另存为——消息图片 lightbox / mermaid
// 导出 / widget 图表截图下载共用；校验与写盘纯函数见 media-export
// （mime 白名单 + 10MB 上限 + 默认名清洗），用户取消返回 null
handleUser(
  "file:saveDataUrl",
  async (
    _,
    _userId,
    dataUrl: unknown,
    defaultName: unknown,
  ): Promise<string | null> => {
    if (typeof dataUrl !== "string" || typeof defaultName !== "string") {
      throw new Error("IMAGE_DATAURL_INVALID");
    }
    const parsed = parseImageDataUrl(dataUrl);
    const result = await dialog.showSaveDialog({
      defaultPath: sanitizeSaveName(defaultName, parsed.ext),
    });
    if (result.canceled || !result.filePath) {
      return null;
    }
    return saveImageDataUrl(dataUrl, result.filePath);
  },
);
// widget 图表区域截图：rect 为渲染层 iframe getBoundingClientRect（DIP，
// 与 capturePage 同单位），event.sender 绑定调用窗无跨窗风险；iframe
// 内部滚动时仅截可视区（协议限制，见组件注释）
handleUser(
  "widget:capture",
  async (event, _userId, rect: unknown): Promise<string> => {
    const { x, y, width, height } = (rect ?? {}) as Record<string, unknown>;
    const valid =
      [x, y, width, height].every(
        (v) => typeof v === "number" && Number.isFinite(v),
      ) &&
      width > 0 &&
      height > 0;
    if (!valid) throw new Error("WIDGET_CAPTURE_RECT_INVALID");
    const image = await event.sender.capturePage({
      x,
      y,
      width: Math.round(width),
      height: Math.round(height),
    });
    return image.toDataURL();
  },
);
```
（dialog import 若缺则补：`import { dialog } from "electron";` 照文件内既有 electron import 惯例；两 handler 插在既有 handleUser 群尾部。）

**验收：** 新 handler 测试绿；MermaidBlock 在 MarkdownView mermaid 块生效（手工验收由用户做，测试层面 widget-renderer/code-block 断言新按钮存在与回调走 api mock）；`npx vitest run tests/ai/` 全绿；prettier 过。

**Commit:** `feat(ai): 聊天导出批接线——saveDataUrl/widget:capture handler+六组件挂接（前批事故恢复）`

---

### Task B: PermissionCapsule 二档单选 UI 重建

**Files:**
- Modify: `src-react/domains/ai/chat/components/PermissionCapsule.tsx`（97 行旧版开关 → 二档单选面板）
- Modify: `src-react/i18n/locales/zh-CN/chat.json` + `en-US/chat.json`（启用 `descDefault`/`descFull` 两个 key——组件重建后引用它们；`panelDefaultDesc`/`panelFullDesc` 旧 key 若不再被引用则删除，保持 key 集双语对称）
- Test: `tests/ai/permission-mode.test.ts`、`tests/ai/new-task-toolbars.test.tsx`（适配单选形态断言）

**组件规格（前批 diff 结构还原）：**
- `MODE_OPTIONS` 数组（value/titleKey/descKey/Icon）：default→`chat:permission.default`+`chat:permission.descDefault`+ShieldCheck；full→`chat:permission.full`+`chat:permission.descFull`+Unlock
- 点击胶囊上弹 Popover：两档单选列表（每行 图标+标题+描述+选中态 Check）；选 default 直接回落；选 full 先弹 `FullAccessModal` 强制免责确认（复用现有组件，确认才 set，取消回弹保持 default）
- props 保持 `{ accessMode: AccessMode; onChange: (mode: AccessMode) => void }` 受控（ChatPane 持有，组件不落库）；权限态文案键 `chat:permission.modeSelector` 作面板标题
- i18n 新 key 文案（zh / en）：
  - `descDefault`: 「文件写入与常用命令直接运行；删除、高危命令等敏感操作先询问」 / "File writes and common commands run directly; deletions and other sensitive operations ask first."
  - `descFull`: 「免确认直接操作此电脑；极高危命令（如磁盘抹除、强推主干）仍会请求确认」 / "Operates this computer without confirmation; extremely dangerous commands (disk wipe, force-push to main) still require confirmation."
- 头注释更新为二档语义（对齐权限放宽批 2026-10-24 文案基准）

**验收：** 组件测试覆盖：两档单选渲染、default 直切、full 弹确认且取消不切；`npx vitest run tests/ai/` 全绿；prettier 过；zh/en key 集对称。

**Commit:** `feat(ai): PermissionCapsule 二档单选面板重建——高危询问语义+full 强确认（前批事故恢复）`

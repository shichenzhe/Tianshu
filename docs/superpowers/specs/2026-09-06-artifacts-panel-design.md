# 右侧产物面板(Artifacts Panel)设计

> 上游:PRD《右侧产物面板》。核心策略:**纯前端从会话消息派生**,
> 零数据库迁移、零新表;后端仅补 3 个文件读取/导出 IPC。

## 1. 范围与策略

| 做 | 不做(YAGNI) |
|----|------|
| 产物文件:AI `write_file` 落盘文件(会话消息派生) | markdown 代码块作为虚拟文件(无稳定标识,后续有需求再加) |
| 工作空间文件:用户 `@` 引用过的工作空间文件 | 扫描工作空间目录全量(会话语义不符,卷入用户自有文件) |
| 概览 = 总览页:两组折叠卡片(产物/工作空间)各带计数与列表 | 概览放 token 用量/模型信息/会话统计(现网已有 context-usage 入口,不重复) |
| 面板内嵌预览 + 全屏切换 | Dialog 弹窗预览 |
| 文件项操作:预览/另存为副本/在 Finder 中显示/复制路径 | 虚拟滚动(会话内文件数几十以内,普通列表足够) |

**链路**:顶栏 PanelRight 图标切换面板 → ChatView 行布局挤压出 340px 面板 →
头部 dropdown(概览/产物文件/工作空间文件,当前项打钩) → 概览两组 Accordion
或单组列表 → 点击文件 → 面板内嵌预览(文本走 MarkdownView/图片直渲) →
可全屏铺满聊天主区域 → "..." 菜单另存/定位/复制路径。

## 2. 数据流(核心决策:会话消息派生)

`chat/lib/artifacts.ts` 新增纯函数:

```ts
interface SessionFile {
  path: string;            // 工作空间相对路径(去重 key)
  kind: "artifact" | "workspace";
  status: "written" | "writing";  // writing 仅流式期间(write_file 运行中)
  lastMessageId: number;   // 源消息(取最新一次)
}
deriveSessionFiles(messages: MessageRecord[], stream?: StreamContent): SessionFile[]
```

- **产物文件**:遍历消息 blocks 的 `tool_call`(`toolName === "write_file"`
  且 `state === "done"`)取 `args.path`;流式期间合并 `chat.store.streams`
  (state=running → `writing`,终态收录为 `written`)
- **工作空间文件**:遍历 user 消息 text 块,解析 `[引用文件 <path>]`
  前缀(固定注入格式,正则提取;`[引用技能 ...]` 忽略)
- 同 path 去重(取 lastMessageId 最大者),按源消息倒序
- 历史消息来自 React Query `["messages", sessionId]`;流式实时性来自
  streams store 订阅;流结束落库后既有 invalidate 链路刷新 —— **PRD
  "实时性"要求天然满足,无额外监听**
- 旧会话(历史消息)直接可派生,无回填问题

## 3. 布局与状态

- **入口**:`ChatView.tsx` 顶部 `WorkspacePathChip` 所在行
  (`flex items-center px-4 pt-2`)改两端对齐,右侧加 `PanelRight`
  图标按钮(Tooltip 模式同 `AiTopbarActions`)。无选中会话不渲染
- **面板**:`ChatView` 内容区改行布局——左列(MessageList + AgentProgress
  + ChatInput,`flex-1 min-w-0`)+ 右侧面板(340px、`border-l`,
  挤压式)。无会话选中时面板不渲染
- **状态**:`ai-ui.store` 新增:
  - `artifactsOpen: boolean`(面板开关,跨会话记忆)
  - `artifactsView: "overview" | "artifacts" | "workspace"`(用户所选
    视图,会话期间记忆,满足 PRD"状态保持")

## 4. 组件(`chat/components/artifacts/`)

```
ArtifactsPanel.tsx   容器:头部 dropdown + 视图路由(overview/artifacts/workspace/preview)
FileListGroup.tsx    分组列表(两组共用),空态"暂无文件"占位
FileListItem.tsx     扩展名图标 + 文件名 truncate + Tooltip;hover 出现 "..."
                     DropdownMenu(模式同 AiSidebar 会话项)
FilePreview.tsx      内嵌预览(返回/文件名/全屏按钮);全屏 = absolute inset-0
                     覆盖聊天主区域;writing 态显示"写入中"占位
```

- 概览 = 两个 Accordion("产物文件 (N)"/"工作空间文件 (M)"),展开即列表;
  单组视图复用 `FileListGroup`
- 头部 dropdown 三项当前项 `Check` 打钩;preview 为面板本地瞬时态
  (非 dropdown 项,返回按钮回到前一列表视图,不落入 artifactsView)
- 预览内容:文本/md/代码走既有 `MarkdownView`(内含 `CodeBlock`),
  图片直接渲染,二进制 → toast"该格式暂不支持预览,请另存查看"

## 5. 主进程新增 IPC(挂 `session.repo.ts` workspace 通道旁)

| IPC | 签名/行为 |
|---|---|
| `workspace:readFile` | `(workspaceId, relPath)` → `{kind:"text"\|"image", content?/dataUrl?, size}`;路径 resolve(fullAccess 语义)、512KB 上限、NUL 二进制检测、图片(png/jpg/jpeg/gif/webp/svg)转 base64 dataURL;ENOENT → 抛"文件不存在" |
| `workspace:revealFile` | `(workspaceId, relPath)` → `shell.showItemInFolder` |
| `workspace:exportFile` | `(workspaceId, relPath)` → `showSaveDialog` + 复制(用户取消返回 null 静默) |

复制路径:`navigator.clipboard.writeText`(纯文本,无需 IPC)。

**路径 resolve 语义**(三 IPC 统一):取 `resolveSafePath` 的 fullAccess
分支——绝对路径直接用,相对路径以 workspacePath 为基,**不做越界拒绝**。
理由:读/导出/定位均为只读操作,且路径源自会话内 write_file 记录;full
access 模式(P3)下 AI 可能写工作空间外的绝对路径,此处必须放行才能预览。

## 6. 边界情况(映射 PRD)

- 文件名过长 → truncate + Tooltip 完整名
- 不支持预览 → 二进制检测命中即 toast 另存提示
- 文件被删 → 预览读取 ENOENT 显示"文件不存在"空态;列表项保留
  (会话历史的一部分,不置灰删除)
- 用户引用后文件被移动/删除 → 同上(读取时才校验)

## 7. i18n

`chat` namespace 新增 `artifacts.*` 系列 key(zh-CN/en-US 同步):
`panelTitle`、`open`/`close`、`view.overview`/`view.artifacts`/`view.workspace`、
`group.artifacts`/`group.workspace`、`emptyFiles`、`preview.back`/
`preview.fullscreen`/`preview.exitFullscreen`/`preview.notFound`/
`preview.writing`/`preview.unsupported`、`action.preview`/`action.export`/
`action.reveal`/`action.copyPath`、`copyPathSuccess` 等。

## 8. 测试

- `deriveSessionFiles` 单测:blocks 解析、引用前缀解析(含技能忽略)、
  去重、流式合并、非 write_file 工具忽略
- `readFile` 单测:越界路径拒绝、超限、二进制、ENOENT、图片 dataURL
  (与 `file-tools.ts` 同款 vitest 模式,纯 Node 可测)
- 组件层不强制单测(项目现状:lib 纯函数有单测,视图组件无)

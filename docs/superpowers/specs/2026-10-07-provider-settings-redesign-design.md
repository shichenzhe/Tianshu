# 模型设置页重设计（主从双栏）· 设计文档

- 日期：2026-10-07
- 状态：已评审通过（方案 A 主从双栏，visual companion mockup 确认）
- 范围：`/module/ai/providers` 页面布局与交互重构（前端）+ 拉取模型列表（后端新 IPC）；API 层其余不动

## 1. 背景与痛点（用户确认 8 条全中）

1. 嵌套表格：模型子表嵌在服务商展开行内，层级拥挤
2. 单开手风琴：同时只能看一个服务商的模型
3. 信息密度倒挂：baseUrl 挤成截断列、模型参数全藏弹窗
4. 两级「添加」入口位置不一致
5. 「管理模型」FolderOpen 图标语义不明
6. 模型 `enabled` 字段无 UI 开关
7. 模型 modelId 全靠手填（仅 Ollama 可批量导入）
8. 弹窗毛刺：服务商编辑弹窗无「取消」、提交态文案跳「ok」

## 2. 方案裁定

- **方案 A（采纳）：主从双栏**——左服务商列表 + 右详情面板（Cherry Studio / LobeChat / ChatBox 一致范式）。切换零成本、连接与模型同屏、扩展性最好
- 方案 B（否决）：卡片流——服务商多时页面过长，深入操作动线不顺
- 方案 C（否决）：表格 + 抽屉——抽屉遮挡主表、两步动线、观感传统

### 2.1 已裁定细节

- 拉取模型列表**四类协议全支持**（openai-compatible / anthropic / gemini / ollama）——缺一类则该类型体验断裂；各协议仅 fetch URL/头/解析差异
- 「测试连接」不单设按钮：**拉取动作兼任**（失败 toast 错误码即连通性结论）
- 选中服务商为页面内 `useState`（非全局 store）；**创建服务商成功后自动选中新项**
- 模型开关走既有 `model:update`（`ModelUpdateParams.enabled` 已存在，零后端改动）
- 历史约束：模型测试（model:test）保留逐个测试（不做服务商级批量测试）

## 3. 布局与组件

### 3.1 结构（mockup 02-design-a-detail，已确认）

```
ProviderSettingsView（双栏壳，p-6 整页）
├─ ProviderList（左列 w-56，边框卡片）
│  ├─ 头行：「服务商」标题 + 「＋ 添加」主按钮
│  ├─ 列表项：名称 + 模型数 pill；选中态 bg-primary-subtle + 左侧 2px 主色条；
│  │   停用服务商整行 opacity 降低 + 「已停用」微标
│  └─ 底行：共 N 个服务商 · M 个模型
└─ ProviderDetail（右列 flex-1，无服务商时空态引导）
   ├─ 详情头：名称 + 类型 Badge + baseUrl（mono，truncate）+ 启用 Switch + 「编辑连接」「删除」
   ├─ 拉取行：「从服务商拉取模型」主按钮（＋ 对 ollama 同一按钮走 /api/tags）+ 说明文案
   └─ ModelList（滚动区）
      ├─ 模型行（border 卡片）：enabled Switch + modelId（mono）+ 参数摘要 + 「测试/编辑/删除」
      ├─ 参数摘要规则：仅显示非默认项（上下文/输出/温度/topP 任一设置过才显示对应「上下文 XK · 输出 XK · T x.x」；全默认显示「默认参数」）
      └─ 尾行 dashed：「＋ 手动添加模型」
```

### 3.2 组件与文件

| 文件 | 变更 | 职责 |
|---|---|---|
| `views/ProviderSettingsView.tsx` | 重写 | 双栏壳、选中态、查询与变更入口、删除确认（AlertDialog 两个保留） |
| `components/ProviderList.tsx` | 新建 | 左列（纯展示 + 回调） |
| `components/ProviderDetail.tsx` | 新建 | 详情头 + 拉取行 + ModelList 组合 |
| `components/ModelList.tsx` | 新建 | 模型行列表（纯展示 + 回调） |
| `components/RemoteModelImportDialog.tsx` | 新建（由 OllamaImportDialog 泛化） | 拉取结果勾选导入；已导入项排末尾置灰不可选 |
| `components/OllamaImportDialog.tsx` | 删除 | 被泛化版取代 |
| `components/ProviderDialog.tsx` | 修改 | 补「取消」按钮；提交态文案统一「保存中…」 |
| `components/ModelDialog.tsx` | 修改 | 提交态文案统一（已有取消） |

参数摘要为纯函数（`lib/model-summary.ts` 新建，`buildModelSummary(model, defaults): string`——defaults 取 ModelDialog 的 DEFAULT_* 同源常量，测试覆盖默认/部分设置/全设置）。

## 4. 后端：拉取模型列表

### 4.1 connectivity.ts 新增 `listRemoteModels`

```ts
export interface RemoteModel {
  modelId: string;
  ownedBy?: string; // 展示归属（openai data[].owned_by / gemini 无）
}
export async function listRemoteModels(
  provider: ProviderRuntimeInfo,
): Promise<RemoteModel[]>;
```

按 `provider.type` 分派（全部 fetch + `AbortSignal.timeout(10_000)`，失败 throw——repo 层经 `classifyError` 归类后向渲染层抛）：

| type | URL 拼法 | 头 | 响应解析 |
|---|---|---|---|
| openai-compatible | `new URL("models", baseUrl)`（baseUrl 惯例含 /v1，相对拼接保留） | `Authorization: Bearer {key}`（key 空则省略）+ extraHeaders 合并 | `data[].id` / `data[].owned_by` |
| anthropic | `new URL("v1/models", baseUrl)` | `x-api-key`、`anthropic-version: 2023-06-01` + extraHeaders | `data[].id` / `data[].display_name` |
| gemini | `v1beta/models` 相对拼接（先剥 baseUrl 末尾既有 `/v1beta`，兼容 presets 形态）+ `?key={key}` | extraHeaders | `models[].name` 去 `models/` 前缀作 modelId |
| ollama | 现有 `listOllamaModels(baseUrl)` | — | 已有 |

非 2xx throw `Error("HTTP {status}")`（与 listOllamaModels 同款）；每类解析后过滤空 id。

### 4.2 repo 与 IPC

- `model.repo.ts`：`handleUser("model:listRemote", (_, userId, providerId) => this.listRemote(providerId, userId))`——`assertOwned(providerId, userId)` 后查 provider 行（含 apiKey/extraHeaders 组 ProviderRuntimeInfo，照 `listOllama` 现有实现同款路径）调 `listRemoteModels`；**返回结构化结果** `ListRemoteResult { success; errorCode?; message; models: RemoteModel[] }`（与 `model:test` 的 `TestConnectionResult` 同模式——连通性失败是预期结果而非异常，渲染端 `t(`ai:errors.${code}`)` 出文案，不走 mapIpcError 白名单）
- `ipc-channels.ts`：`IPC_INVOKE_ALLOWLIST` 加 `"model:listRemote"`（紧跟 `model:listOllama`）
- 前端 `model.api.ts`：`ModelApi.listRemote(providerId): Promise<RemoteModel[]>` + `RemoteModel` 类型（后端 connectivity 经 repo 消费，类型放前端 api 文件为单一事实源——**反转：RemoteModel 定义在 model.api.ts，connectivity import type**，同 MonitorStats 先例）

## 5. 数据流与状态

- `providers` / `models` 两个既有 query 不变（`["providers"]` / `["models"]`）
- 选中服务商：`selectedId: number | null`；providers 数据就绪且 selectedId 空时默认选中首个；创建服务商成功后（invalidate 后）选中返回的新 id（`provider:create` 返回 record，含 id）
- 拉取对话框：`useQuery({ queryKey: ["remote-models", providerId], queryFn: listRemote, enabled: open })`；导入逐个 `ModelApi.create`（已存在的跳过——对话框已置灰不可选）后 invalidate models
- 模型开关：乐观更新（queryClient.setQueryData 本地翻转）→ `ModelApi.update({ id, enabled })` → 失败回滚 + toast
- 删除服务商后：若删的是选中项，回落选中首个

## 6. i18n（ai namespace，zh/en 同步）

新增 key（camelCase 分层）：`provider.masterTitle`（「服务商」列标题）、`provider.summary`（「共 {{providers}} 个服务商 · {{models}} 个模型」，插值）、`provider.disabledTag`（「已停用」）、`provider.editConnection`、`provider.emptyDetail`（无选中空态）、`provider.selectFirst`（引导文案）、`model.fetchRemote`（「从服务商拉取模型」）、`model.fetchRemoteHint`、`model.addManually`、`model.defaultParams`（「默认参数」）、`model.contextSummary`/`model.outputSummary`/`model.tempSummary`（摘要片段插值）、`model.importTitle`（「从 {{name}} 拉取模型」）、`model.importSelected`（「导入所选 {{count}} 个」）、`model.importSelectedAll`、`model.imported`（「已导入」）、`model.fetchFailed`。废弃 key（删除）：`provider.manageModels`、Ollama 专用文案若不再引用则删（`model.importOllama` 等，实现时以 grep 引用为准）。

## 7. 错误处理

| 场景 | 处理 |
|---|---|
| 拉取失败（网络/401/超时） | 结构化 errorCode → 对话框内错误态（`ai:errors.{code}` + 原始 message + 重试按钮），不另发 toast（避免与对话框内错误态重复打扰） |
| 模型开关失败 | 乐观回滚 + toast |
| 删除/更新失败 | 既有 toast 路径不变 |
| 拉取返回空列表 | 对话框空态文案（非错误） |

## 8. 测试计划

- `connectivity.test.ts` 扩展：`listRemoteModels` 四协议 fetch mock（成功解析/HTTP 401/超时/空 id 过滤/gemini 前缀剥离）——照现有 connectivity.test 风格
- `model-summary.test.ts`：默认/部分/全设置三态
- 组件测试（照 monitor-view 模式轻量）：ProviderList 选中回调与停用态、ModelList 开关回调与摘要渲染、RemoteModelImportDialog 勾选与已导入置灰（mock ModelApi）
- 全量回归 `npm run test` + `npm run typecheck`
- 手动验收（用户）：双栏切换、四类协议拉取（有真实 key 的服务商）、开关乐观更新、创建后自动选中

## 9. 范围外（YAGNI）

- 模型排序/分组/搜索、默认模型标记、批量启停、拖拽
- 服务商级批量模型测试
- 窄屏左列折叠（桌面应用最小宽度可控）
- gemini 分页 token（模型列表一页足够）

## 10. 文件清单

| 层 | 文件 | 变更 |
|---|---|---|
| 主进程 | `electron/domains/ai/provider/connectivity.ts` | +listRemoteModels（四协议） |
| 主进程 | `electron/domains/ai/provider/model.repo.ts` | +listRemote + IPC 注册 |
| 主进程 | `electron/commons/ipc-channels.ts` | +model:listRemote |
| 渲染端 | `src-react/domains/ai/api/model.api.ts` | +RemoteModel +ModelApi.listRemote |
| 渲染端 | `src-react/domains/ai/provider/views/ProviderSettingsView.tsx` | 重写（双栏壳） |
| 渲染端 | `src-react/domains/ai/provider/components/ProviderList.tsx` | 新建 |
| 渲染端 | `src-react/domains/ai/provider/components/ProviderDetail.tsx` | 新建 |
| 渲染端 | `src-react/domains/ai/provider/components/ModelList.tsx` | 新建 |
| 渲染端 | `src-react/domains/ai/provider/components/RemoteModelImportDialog.tsx` | 新建（泛化） |
| 渲染端 | `src-react/domains/ai/provider/components/OllamaImportDialog.tsx` | 删除 |
| 渲染端 | `src-react/domains/ai/provider/components/ProviderDialog.tsx` | 修改（取消按钮/文案） |
| 渲染端 | `src-react/domains/ai/provider/components/ModelDialog.tsx` | 修改（文案） |
| 渲染端 | `src-react/domains/ai/provider/lib/model-summary.ts` | 新建（纯函数） |
| 渲染端 | `src-react/i18n/locales/{zh-CN,en-US}/ai.json` | 新增/废弃 key |
| 测试 | `tests/ai/connectivity.test.ts`、`tests/ai/model-summary.test.ts`、`tests/ai/provider-*.test.tsx` | 扩展/新建 |

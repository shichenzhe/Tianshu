# imageGen 节点适配 ComfyUI workflow API — 设计文档

- 日期：2026-10-23
- 状态：已评审（brainstorming 定稿）
- 分支：feat/imagegen-comfyui

## 背景

工作流图像生成节点（kind:imageGen）现状仅支持 OpenAI 兼容协议：`POST {provider.baseUrl}/images/generations`（`model/prompt/size/n` 请求体，`b64_json`/`url` 双兼容响应），产物落盘 `workflowAssetsDir()`，节点输出为文件绝对路径。本地 SD 生态主流的 ComfyUI 无法直连——其原生 workflow API（`/prompt` 提交 + `/history` 轮询 + `/view` 取图）与 OpenAI 同步 HTTP 形态完全不同。

另有一处存量缺口：imageGen 输出在运行轨迹（GraphRunTraceView）中只显示一行文件路径，图本身不可见。本次一并补齐。

## 目标

1. imageGen 节点支持 ComfyUI workflow API 协议（与 openai 协议并存，节点上切换）
2. ComfyUI 地址经 provider 体系集中管理（用户已裁定 provider 化，不采用节点直配）
3. workflow JSON 用占位符注入 prompt/尺寸/上游变量（用户已裁定占位符方案，不采用标注节点 id）
4. 运行轨迹内生成图片可视化（openai 协议同样受益）

## 非目标

- websocket 进度推送（轮询足够，YAGNI）
- 多图输出的多路输出（只取第一张，见假设）
- 远程主机 run 图片的跨主机数据面透出（HD workspace 协议化后续议题）
- ComfyUI 的模型/节点清单浏览、参数化表单生成（workflow JSON 手工粘贴即可）
- 超时/重试 UI 暴露（timeoutMs 走 schema 默认值）

## 设计

### 1. 数据模型（零 DB 迁移）

- `Provider.type` 为自由 String 列，新增枚举值 `"comfyui"` 不动表结构
- **ComfyUI provider 不建 model 行**：checkpoint 全在 workflow JSON 内指定，无模型列表概念；chat 链路 `createChatModel` 按 model 行触达，天然不受影响
- 前端 `src-react/domains/ai/api/provider.api.ts` 的 `PROVIDER_TYPES` 加 `"comfyui"`，`ProviderType` 类型随之扩展
- `src-react/domains/ai/provider/model/presets.ts` 加 ComfyUI 预设（baseUrl `http://127.0.0.1:8188`）
- 鉴权复用现有字段：`apiKey` 有值时 `Authorization: Bearer`（覆盖反代场景），`extraHeaders` 透传——零新字段

### 2. graph schema（packages/tianshu-core/src/graph-schema.ts）

`imageGenNodeSchema` **平铺加字段 + superRefine 互斥校验**，不用 discriminatedUnion——旧图数据无 `protocol` 字段，union 分发时两分支皆失败会打翻整图解析；平铺 + default 保证旧图零迁移：

```ts
kind: z.literal("imageGen"),
protocol: z.enum(["openai", "comfyui"]).default("openai"),
modelId: z.number().int().positive().optional(),      // openai 必填（superRefine）
providerId: z.number().int().positive().optional(),   // comfyui 必填（superRefine）
workflowJson: z.string().optional(),                  // comfyui 必填（superRefine）
prompt: z.string().min(1),                             // 现状不变
size: z.string().default("1024x1024"),                 // 现状不变
randomizeSeed: z.boolean().default(true),
timeoutMs: z.number().int().min(5_000).max(600_000).default(300_000),
```

superRefine 规则：`protocol==="openai"` 时 `modelId` 必填；`protocol==="comfyui"` 时 `providerId`、`workflowJson`（非空）必填。

- 导出类型守卫 `isComfyUIImageGen(node): boolean` 供执行器/UI 收窄
- `ImageGenNode` 类型上 `modelId` 变 optional——现有 openai 消费点（generateImage、ModelSelect、NodeCard 摘要）在守卫/默认分支下处理 undefined
- 改后 `npm run sync:core` 重建两共享包 dist（server 消费 dist）

### 3. 执行器（electron + apps/tianshu-server 双份同构）

`makeImageGenNodeHandler` 按 `protocol` 分流；openai 路径原样不动。comfyui 路径新增 `generateImageComfyUI(node, ctx, prompt)`：

1. **取 provider**：新增小函数 `loadProviderRuntime(providerId)`（loadModelRuntime 同款风格，返回 baseUrl/apiKey/extraHeaders；查无报 `provider_missing` 语义错误）
2. **size 解析**：`"1024x1024"` → width/height 整数对，非法格式报 `comfyui_invalid_size`（防御性，UI Select 已限定格式）
3. **workflowJson 渲染**（两段式）：
   - 先做本地占位替换：`{{prompt}}`→节点 prompt（模板渲染后）、`{{width}}`/`{{height}}`→尺寸值、`{{seed}}`→随机 int（randomizeSeed 时）
   - 再走既有 `renderNodePrompt` 管道注入上游变量（`{{input.x}}`/`{{nodes.<id>.output}}`/`{{date}}` 等天然可用）
   - `JSON.parse` 失败报 `comfyui_workflow_invalid`
4. **seed 随机化**：`randomizeSeed` 为真且用户未占位 `{{seed}}` 时，深度遍历 workflow 所有节点 `inputs`，将 key 为 `seed`/`noise_seed`/`rand_seed` 的值替换为随机 int——防 ComfyUI 缓存命中导致同 prompt 出同图
5. **提交**：`POST {base}/prompt`，body `{ prompt: workflow, client_id }`（client_id 随机串）；HTTP 非 200 或响应 `node_errors` 非空报 `comfyui_api_error`
6. **轮询**：`GET {base}/history/{prompt_id}`，1s 间隔，每轮响应 `ctx.abort` 中止，超 `timeoutMs` 报 `comfyui_timeout`
7. **取图**：history `outputs` 汇总 `images` 数组（`type==="output"`），空报 `comfyui_no_output`；取第一张 `GET {base}/view?filename=&subfolder=&type=` 下载（失败报 `comfyui_download_failed`），落盘 `workflowAssetsDir()/image-{ts}.png`，返回绝对路径
8. **trace 填充**：成功出口把落盘文件转**相对数据根路径**（`workflow-assets/image-{ts}.png`）写入 trace entry 的 `outputImage` 字段（见 §4；openai 路径出口同样填充）

错误码全集：`comfyui_workflow_invalid` / `comfyui_invalid_size` / `comfyui_request_failed`（fetch 网络层）/ `comfyui_api_error` / `comfyui_timeout` / `comfyui_no_output` / `comfyui_download_failed`，全部走 `GraphNodeFailure(node.id, code, message)` 既有通道。

### 4. 图片展示（运行轨迹可视化）

- `TraceEntry`（executor 双份构造 + `GraphRunTraceView.tsx` 就地镜像类型）加可选字段 `outputImage?: string`（相对数据根路径）
- `GraphRunTraceView` 的 `TraceDetail`：`entry.outputImage` 存在 → 渲染 `MessageImage`（`src-react/domains/ai/chat/components/MessageImage.tsx`）——IPC `file:readMessageImage` 读 dataUrl → 缩略图（max-h-48）+ 点击 lightbox 全屏 + 失效降级占位条 + queryKey 缓存，整链复用零新机制；无该字段时保持纯文本 `outputPreview`（其他节点不受影响）
- 路径安全天然满足：`readImageAsDataUrl` 的 rootDir 即 `appDataHome()`，`workflow-assets/` 相对路径通过防 `../` 穿越校验（`electron/commons/paths.ts:64` 同根）
- 前端跨域 import 先例：GraphRunTraceView 已 import automation 域 lib，chat 域组件 import 同理可用
- server 无头端 executor 同构填充 `outputImage`（server 数据根 `~/.tianshu-server`，相对路径语义一致）

### 5. 前端 UI

- `ImageGenNodeFields`（GraphNodeEditor.tsx）：顶部加协议 Select（openai/comfyui）；切协议时 onPatch 清对侧字段
  - openai 态：现有 ModelSelect + size + prompt 不变
  - comfyui 态：`ProviderSelect`（新小组件：providers 过滤 `type==="comfyui"`，空集时提示去设置页添加）+ workflowJson 大编辑区（`HighlightTextarea` language=json，height≈200）+ size（Select 保留）+ prompt + randomizeSeed 开关（Switch）
  - timeoutMs 不暴露 UI（用默认 300s）
- 设置页 `ProviderDialog`：type 下拉加 ComfyUI（随 PROVIDER_TYPES 扩展自动出现，表单无需特判——apiKey 本就 optional）
- `connectivity.testConnection`（electron/domains/ai/provider/connectivity.ts）加 comfyui 分支：`GET {base}/system_stats` 200 即通；`listRemoteModels` 对 comfyui 不适用（前端隐藏拉模型入口或提示不支持，实施时按现有 UI 结构取轻）
- `NodeCard`/`graph-canvas-model.ts` 的 imageGen 摘要：comfyui 态显示 provider 名（openai 态保持现状）
- `graph-editor-model.ts` 的 `newImageGenNode` 默认值补 `protocol:"openai"`（+ `randomizeSeed:true`/`timeoutMs:300_000` 按 schema 默认显式化，风格随现有节点默认值写法）

### 6. server 侧（apps/tianshu-server）

- `src/core/graph/graph-executor.ts`：同款 `generateImageComfyUI` + `loadProviderRuntime` + trace `outputImage`（与 electron 侧 diff 同构）
- provider 域 type 校验：实施时核对 server 侧 provider DTO/repository 是否有 type 白名单，有则同步加 `comfyui`（DB String 列本身无约束）
- `src-react/domains/ai/data-source/remote-catalog.ts` 的 `toProviderRecord`：type 字段 string 透传，前端 `ProviderType` 扩展后 cast 对齐

### 7. i18n

`src-react/i18n/locales/{zh-CN,en-US}/chat.json` 双份同步新增 key（协议标签、ComfyUI 字段 label/hint、空 provider 提示、连通性测试文案）——命名空间 `orchestration.editor.*` 与 `provider.*` 既有分层。

## 测试

1. **schema 单测**（tianshu-core，vitest）：旧图无 protocol 落 openai 默认；superRefine 互斥两方向；randomizeSeed/timeoutMs 默认值
2. **执行器单测**（mirror vitest + server jest 双份，mock fetch）：提交→两轮轮询→下载成功链路；node_errors 非空；轮询超时；`{{width}}/{{height}}/{{prompt}}` 占位替换断言；seed 随机化断言（两次执行 seed 值不同）；workflowJson 非法 JSON 报错；`outputImage` 相对路径断言
3. **trace 展示**：TraceDetail 有 outputImage 渲染 MessageImage、无则纯文本（组件级测试跟随现有 orchestration 测试组织）
4. **drift**：双份执行器同步增长，`npm run check:drift -- --rebase` 重置基线并人工复核差异行
5. 回归：`npm run test`（根）+ `npm run test -w apps/tianshu-server` + `npm run typecheck` + `npm run lint`

## 假设与边界（已裁定/标注）

1. **多图输出只取第一张**（对齐现有 `n:1` 语义；其余丢弃）
2. **prompt 值内含 `{{input.x}}` 字面量会被二次渲染**（renderNodePrompt 管道特性，边缘场景接受）
3. **默认超时 300s、上限 600s**（本地 SD 出图可数分钟，上限对齐 vectorize 超时风格）
4. **旧图零迁移**（无 protocol 字段 → default openai）
5. **图片读取沿用 10MB 上限**（`IMAGE_READ_LIMIT`）——ComfyUI 高分辨率 PNG 超限时轨迹内降级「图片已失效」占位条（语义略糙，后续按需放宽）
6. **远程主机 run 图片**存于远程数据根，本地 IPC 读不到 → 降级占位条；跨主机图片透出随 HD 后续议题
7. ComfyUI 无鉴权为常态；反代 Bearer 场景由 provider apiKey 覆盖
8. **seed 语义**：`{{seed}}` 占位与自动随机化共用同一随机值（randomizeSeed=true 时注入）；`randomizeSeed=false` 时两者皆不生效——seed 完全由 workflow JSON 静态值自管（可复现出图）

## 实施拆解建议（供 writing-plans 细化）

1. schema + isComfyUIImageGen + sync:core（含 schema 单测）
2. electron 执行器 comfyui 分支 + trace outputImage（含单测）
3. server 执行器同构 + server 单测 + drift rebase
4. 前端：ProviderSelect + ImageGenNodeFields 协议切换 + NodeCard 摘要
5. 设置页：PROVIDER_TYPES/presets/ProviderDialog/connectivity comfyui 分支
6. GraphRunTraceView outputImage 展示
7. i18n 双份 + 全量回归

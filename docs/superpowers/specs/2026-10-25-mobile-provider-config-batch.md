# 移动端服务商配置批（A1+B3）设计 spec

日期：2026-10-25
状态：已评审通过（设计两节呈报 + 两项裁定：B2 重定界为自动化任务创建、桌面被控面开放 provider/save）
关联：差集 spec `2026-10-25-mobile-desktop-gap.md`（A1、B3 条目）；A6 监控批同款三段式先例

## 1. 背景与裁定

### 1.1 现状盘点（探查结论，file:line 证据见探查记录）

- **协议**：`ENDPOINTS.provider.save === "provider/save"` 已存在；`provider/test`、`provider/fetchModels` 也在协议中。
- **无头端**（apps/tianshu-server）：`provider/save` 是最完整写面契约——upsert 数组（`providers?`/`models?` 两数组，带 `id` 更新、不带新建），全批交互式事务回滚，归属校验（provider 按 `{id,userId}`、model 校验 provider 归属 + `{id,providerId}` 对账），密钥三态（undefined 保留 / null 清除 / 缺省 null），**掩码防回写**（`apiKey === REDACTED_SECRET` 按未传处理；`extraHeaders` 字符串含掩码按未传处理），保存响应重新 query 故也脱敏。
- **桌面被控面**（electron/domains/server-face）：已注册 `provider/query`（bundle 脱敏）/ `delete`（providerIds 级联 + modelIds 单删）/ `test` / `fetchModels`；**无 `provider/save`**——历史裁定（ipc-channels.ts:330-335：被控端模型配置应由本地 AI 页管理）。注意：delete 既已开放，"只读"已是历史说法，准确缺口是"无 save 新增/编辑写面"。
- **桌面本地写面**：`provider:create/update` + `model:create/update/delete` IPC（ProviderRepository.create/update、ModelRepository.create/update，签名见探查记录）；密钥明文落库（与无头端一致），掩码只读不回传。
- **移动端**：零 provider 管理 UI；仅会话页 ModelPicker 只读消费 `provider/query`。settings 我的页无 provider 入口。无 providers store。

### 1.2 本批裁定（用户拍板）

- **Ruling：桌面被控面开放 `provider/save`。** 理由：delete（更危险）已开放；face token 即完全信任（默认关闭、开启才生成 token）；relay 链路有 E2E 加密。移动端由此一套 save 代码通吃无头端与桌面被控端两种主机。
- **Ruling：save 契约逐字对齐无头端 DTO**（providers/models 两数组 upsert、字段与三态语义一致）——移动端不分主机类型。
- **Ruling（差异声明）：桌面 face save 顺序应用 + 逐项错误汇总，不做全批回滚**（无头端是交互式事务回滚）。依据：桌面 repo 无事务先例（delete 即串行循环）；upsert 幂等，部分失败后重试可恢复；不为它侵入 repo 加事务。差异写入本 spec 与计划，审查以本 spec 为权威。
- **Ruling：B3 零协议改动**——`provider/test`、`provider/fetchModels` 桌面被控面与无头端均已注册，移动端纯消费。
- **Ruling：不动无头端**（save/test/fetchModels 本就齐全）；不动桌面本地 IPC 面。

### 1.3 非目标

- 桌面 providers 页的 UI 重构（桌面不动）。
- provider 预设（presets）库的下发——移动端新建表单的预设写死移动端本地（与桌面预设同款静态列表）。
- ComfyUI provider 的"测试连接"（`/system_stats`）远端变体——移动端按桌面同款口径：ComfyUI 不显示远端拉取；测试走 face 的 `provider/test`（统一 listRemote 语义，两端一致）。
- 图/自动化相关（B2 另批）。

## 2. 三层设计

### 2.1 协议包：save 契约类型收编（单份权威源）

新文件 `packages/tianshu-protocol/src/provider-save-contract.ts`（纯类型 + 常量，零运行时依赖）：

- `ProviderSaveItem`：逐字镜像无头端 `ProviderItemDto`（`id?/name/type/baseUrl/apiKey?/extraHeaders?/enabled?`，含字段注释与三态语义注释）。
- `ModelSaveItem`：逐字镜像 `ModelItemDto`（`id?/providerId/modelId/name?/type?/enabled?/temperature?/topP?/maxTokens?/contextWindow?`）。
- `ProviderSavePayload`：`{ providers?: ProviderSaveItem[]; models?: ModelSaveItem[] }`。
- `REMOTE_MODEL_LIMIT`（远端拉取 10 秒超时）等已有常量不动；`REDACTED_SECRET` 已有。

`src/index.ts` 聚合 export 增该模块（七模块 → 八模块，注释同步）。

**收编后改引**：无头端 `ProviderSaveDto` 保持 class-validator 装饰器类原位（运行时校验需要装饰器，不在协议包），但其字段类型注释以协议类型为权威；桌面 face 与移动端直接消费协议类型。收编的是**形状**（type 层），不是运行时 DTO 类——与 A6 monitor-contract 先例同款（zod/装饰器运行时留原地）。

### 2.2 桌面被控面：`provider/save` 路由

- `deps.ts` `ServerFaceProviders` 增 `save(payload: ProviderSavePayload, userId: number): Promise<unknown>`（返回保存后的脱敏 bundle，对齐无头端"保存后重新 query"口径）。
- `ipc.ts` 桥实现（顺序应用）：
  1. 先应用 `providers` 数组：每项 `id` 存在 → `providerRepo.update`（掩码防回写：`apiKey === REDACTED_SECRET` 删除该键、`extraHeaders` 含掩码删除该键——复用/对齐无头端 repository.ts:67-76 语义）；无 `id` → `providerRepo.create`（掩码值落空值/跳过密钥键）。
  2. 再应用 `models` 数组：`id` 存在 → `modelRepo.update`；无 → `modelRepo.create`。
  3. 任一项抛错 → 停止后续项，返回业务错误（code/message 带项标识）；已应用项不回滚（差异声明见 §1.2）。
  4. 全部成功 → 返回 `listBundle(userId)`（脱敏）。
- `routes.ts` 仿 handleProviderDelete 增 `handleProviderSave` + 注册 `"POST provider/save"`（放在 provider/query 后）。
- `ENDPOINTS` 已含 `provider/save`——**协议常量零改动**；但 `tests/ai/server/protocol-package.test.ts` 的 ENDPOINTS 表已含 provider.save 无需动。
- 归属校验：repo 层 `assertOwned` / model 的 provider 归属内建，桥层不重复。

**安全面注记**：save 经与 delete 同一 token 鉴权面；请求体含密钥只在写方向（响应仍脱敏）；掩码防回写堵"读-改-写覆盖真实密钥"路径。

### 2.3 移动端：providers 管理

**store 层**（仿 sessions.store 骨架）：
- `src/store/providers.store.ts`：state `{ bundle: { providers: ProviderRow[]; models: ModelRow[] } | null, loading, error, saving }`（ProviderRow/ModelRow 为 store 内 wire 防御解析行类型，同 sessions.store 惯例，不落协议包）；`load()` 经 `wireRequest("POST", ENDPOINTS.provider.query, null)`；`saveProvider(item)` / `saveModel(item)` 本地构造 ProviderSavePayload 单元素数组调 `provider/save`，成功后合并回 bundle（不重拉全量）；`removeProviders(ids)`/`removeModels(ids)` 走 `provider/delete`（本批新增消费）；`testProvider(providerId)`、`fetchRemote(providerId)` 直通。
- 测试替身模式同 sessions.store.test（vi.mock connections.store）。

**UI 层**：
- settings 我的页「服务商配置」入口行：`capabilities?.includes("provider")` 门禁（对齐监控入口写法），`router.push("/providers")`。位置：用量监控行后。
- `src/app/providers.tsx`（Stack 注册，headerShown false 自绘顶栏）：
  - 服务商组卡列表：名称、模型数、停用标记；行点击进详情；右上「+」新建。
  - 详情态（选中 provider）：信息卡（名称/type/baseUrl/enabled Switch）、「编辑」「删除」（Alert 确认，提示级联删模型）、「拉取远端模型」。
  - provider 新建/编辑 Dialog：预设选择（静态同款列表）、名称、type 五选、baseUrl、apiKey（编辑态占位「已配置」不改动不传/显式清除传 null）、extraHeaders（JSON 合法性校验）、enabled。
  - 模型组卡：行（显示名/modelId/enabled Switch）；「手动添加」；行长按/详情 → 编辑（modelId/名称/type/LLM 四参数 temperature/topP/maxTokens/contextWindow，校验 maxTokens<contextWindow 正整数）、删除（确认）、「测试」（B3，行内 loading→成功/失败 toast 态）。
  - 远端拉取导入（B3）：`fetchRemote` 结果列表 → 已导入 modelId 置灰排尾 → 勾选/全选 → 逐项 saveModel（modelId+providerId+type 启发式预填）→ 完成刷新。
- i18n 新命名空间 `providers`（zh/en 同步注册）：title/addProvider/editProvider/deleteProvider/deleteConfirm/cascadeHint/name/type/baseUrl/apiKey/apiKeyPlaceholder/apiKeyConfigured/clear/extraHeaders/invalidJson/enabled/models/addModel/editModel/modelId/displayName/temperature/topP/maxTokens/contextWindow/maxTokensLtContext/test/testing/testOk/testFailed/fetchRemote/fetching/import/imported/selectAll/selected/saveFailed/loadFailed/retry 等。
- 三态：loading/error+retry/空（无服务商引导新建）。

## 3. 测试与验收

- 协议包：build dist 后类型消费端（face + mobile）typecheck 绿；协议钉测试零改动（ENDPOINTS/CAPABILITIES 无变化）。
- face：`tests/ai/server-face/routes.test.ts` 补 save 用例——新建/更新/掩码防回写/归属失败/部分失败错误汇总/成功后 bundle 脱敏。
- 移动端三件套：typecheck + vitest（store 测试：load 解包/save 合并/delete/test/fetchRemote 载荷）+ prettier；既有 268 测试不得红。
- 根侧：`npm run typecheck` + server-face vitest 绿。
- 真机验收（移交用户）：手机对桌面被控端建 provider（含 apiKey）→ 拉取远端模型导入 → 会话页 ModelPicker 选到新模型发消息；启停/删除/编辑回环；掩码场景：编辑 provider 不动密钥保存后密钥仍可用。

## 4. 风险

- **save 开放扩大写面**：token 泄露者可改写 AI 配置（baseUrl 指向恶意端点）。缓解：face 默认关闭 + token 32 字节随机 + relay E2E；与 delete 同级的既有风险接受（用户已裁定）。
- **顺序应用 vs 事务**：部分失败留中间态。缓解：幂等 upsert 重试；错误信息带项标识。
- **远端拉取超时**：10s（桌面 connectivity）/5s（无头端）弱网失败——error+重试 UI 兜底，与 A6 relay 超时同款接受。
- **双份漂移**：face 文件 mirror 独有，drift 巡检不受影响。

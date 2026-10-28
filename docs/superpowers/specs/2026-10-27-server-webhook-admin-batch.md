# 无头端 webhook 管理三端点批设计 spec

日期：2026-10-27
状态：直接开工（用户「继续推进」滚动授权；先例与蓝本齐备）
关联：无头服务端待办盘点（README:160「注册管理面为 service 级 API，HTTP 端点待后续批」之兑现）；server graph-automation 批（2026-10-17）

## 0. 事实基线

- **server 侧 service API 已齐零调用方**：`WebhookService.registerWebhook/unregisterWebhook/getWebhookRegistration`（`apps/tianshu-server/src/modules/webhook/webhook.service.ts:220/256/270`）已实现，但仅 graph.module deleteGraph 钩子消费 unregister——`registerWebhook` 在无头端**无任何调用方**，即部署态无法开启 webhook（只能装载既有 option 行）。
- **蓝本**：mirror 桌面三 IPC（`electron/domains/ai/orchestration/graph.repo.ts:280-330`）——`orchestration:webhookEnable(graphId, config?) → url` / `webhookDisable(graphId)` / `webhookStatus(graphId) → {enabled, url, responseTemplate?, statusCode?, async?, fullAccess?}`；前端封装 `src-react/domains/ai/orchestration/api/orchestration.api.ts:176-206`，UI 面在 GraphEditorView。
- **face 缺口**：mirror server-face routes 无 webhook 管理端点；移动端无图编辑器——两端消费面本批均不做（留档另批）。
- **安全约束（路径裁定根因）**：静态 token 守卫对 `${contextPath}/webhook/` 前缀豁免（`token.guard.ts:21-24`，终审 F1——外部系统凭每图 token 触发）。管理面若落 `/webhook/*` 则匿名可注册，且 `fullAccess`（图级全权：代码/写节点放行）可被外部自开——不可暴露，HTTP 路径必须避开该前缀。
- **协议现状**：`ENDPOINTS.webhook` 仅触发两段（`webhook/:token` / `webhook/:token/jobs/:id`，占位形态）；mirror 钉测试 `tests/ai/server/protocol-package.test.ts:250-255` 钉 webhook 组；SDK 契约 `test/sdk-contract.spec.ts:241-244` webhook 两段显式入册（graph/automation/tool/webhook 四组显式）。
- **fullAccess 为无头端先行扩展**：mirror 桌面 IPC config 无此字段（server `WebhookConfig` 独有，外部触发授权挂注册上）；协议面透出。
- **测试基建**：`test/modules/webhook.spec.ts` 已有 createTestDb+createTestApp+mkGraph e2e 基建（同步/异步/裸 token/删除级联用例在册）；`test/commons/token-guard.spec.ts` 守卫单测在册。

## 1. 本批裁定

1. **协议三段**：`ENDPOINTS.webhook` 增 `enable: "graph/webhook/enable"` / `disable: "graph/webhook/disable"` / `status: "graph/webhook/status"`（组保持 webhook 分类内聚，逻辑路径值带 `graph/webhook/` 前缀——注释说明：管理面业务语义受 TIANSHU_TOKEN 守卫，路径避开 `/webhook/` 触发面豁免前缀是安全裁定）。mirror 钉测试 2→5 段。
2. **server 三端点**（挂 `WebhookController`，POST 风格照 graph.controller 先例，`@Public()` 豁免 JWT、静态 token 守卫照常生效）：
   - `POST /graph/webhook/enable`：`{graphId, responseTemplate?, statusCode?, async?, fullAccess?}` → graph 存在性校验（`BusinessException(ErrorCodeEnum.NOT_FOUND)`，starter 通用码）→ `registerWebhook`（重开换新 token，旧 token 失效）→ 回 `{enabled:true, url:"/webhook/<token>", ...config}`——url 为相对路径（无头端部署 host/前缀不定，控制端拼自身 base；service 头注释适配点 6 同裁定）。
   - `POST /graph/webhook/disable`：`{graphId}` → `unregisterWebhook`（幂等：未注册也 ok）→ `{enabled:false}`。
   - `POST /graph/webhook/status`：`{graphId}` → `{enabled, url, ...config}`（形状对齐桌面 `webhookStatus`）。
   - DTO 新建 `modules/webhook/dto/`（WebhookEnableDto / WebhookIdDto），`@ApiProperty` 全标（SDK 请求面）；statusCode 校验 100-599 整数（service parseConfigValue 同口径）。
3. **SDK 契约**：`sdk-contract.spec.ts` webhook 显式表 2→5 段；`npm run sdk:generate` 重导产物（openapi.json + api-types.d.ts，gitignore 按需重生）。
4. **测试**：并入 `test/modules/webhook.spec.ts`（同域内聚）——enable 落库（option 行）+ 回显 + 重开换 token 旧 404；enable 图不存在 4040；disable 注销（行删 + 旧 token 触发 404）+ 未注册幂等 + 在途运行中止；status 两态（未注册 `{enabled:false,url:""}`）；token-guard 补一条「管理路径不落豁免前缀」判定用例。
5. **README**（apps/tianshu-server）：编排能力段 webhook 注册管理面说明更新（service 级 API → HTTP 三端点已落）。

## 2. 非目标（留档）

- 桌面 face 桥（远程桌面遥控 webhook 配置）与移动端编排 UI 消费面——另批。
- 事件总线副本（Ruling 10）/ disabledTools 注入——待办清单其余项，另批。
- mirror 桌面 IPC 面零改动（本地面已在，不涉及）。

## 3. 风险

- 协议组值与组名前缀不一致（webhook 组值带 graph/ 前缀）——注释钉死根因，防后人「顺手归一」改回 /webhook/ 前缀破安全边界。
- 协议包改动后 server 侧 symlink 消费 dist——须重建协议包再跑 server 测试（`npm --prefix packages/tianshu-protocol run build`）。

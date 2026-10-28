# webhook 配置桌面遥控面批（WH 消费端）设计 spec

日期：2026-10-27
状态：直接开工（用户「继续」滚动授权；协议端点 WH 批已备）
关联：WH 批（2026-10-27-server-webhook-admin-batch——graph/webhook/{enable,disable,status} 三端点）；GA-T8（GraphPanel 编排遥控）

## 0. 事实基线

- **协议端点已备**：`ENDPOINTS.webhook.enable/disable/status` = `graph/webhook/*`（无头端已实现，返回 `{enabled,url,..四配置}`，url 为相对路径）。
- **桌面链路**：GraphPanel（`src-react/domains/ai/server/components/GraphPanel.tsx`）经 `GraphApi.graphList` → IPC `server:graphQuery` → `remoteHandler(registry, "graph/query")` 透传（`electron/domains/server/ipc.ts:199` 起 GA-T8 九通道同款）。图行现为名称/节点数/状态徽标 + run/abort。
- **wire 类型先例**：graph.api.ts 本地 type-only 同构副本（RemoteGraphRecord 等）——WebhookManageResult 同款（协议包无此类型）。
- **测试基建**：`tests/ai/server/graph-panel.test.tsx`（16K，run/abort/事件流用例在册）。
- **移动端无图管理面**（app/ 仅 automation/new 对话式创建）——本批不做，留档。

## 1. 本批裁定

1. **IPC 三通道**：`ipc.ts` GA-T8 块尾增 `server:webhookEnable|Disable|Status` → `graph/webhook/{enable,disable,status}`（remoteHandler 同款透传，字面量路径与现有通道风格一致）。
2. **graph.api.ts 三方法**：`webhookEnable(graphId, config?, connId)` / `webhookDisable` / `webhookStatus`——返回 `RemoteWebhookManage`（wire 同构副本：enabled/url/responseTemplate?/statusCode?/async?/fullAccess?）。
3. **GraphPanel 图行增 webhook 入口**（保持面板轻量——Popover 而非 Dialog）：
   - 图行尾增 Webhook 图标钮（lucide `Webhook`；已启主色调、未启 muted）——打开时惰性 status 拉取
   - Popover 内容两态：未启 = enable 表单（模板/状态码/async/fullAccess 开关）+ 开启钮；已启 = URL 行（相对路径 + 复制钮 + 「拼主机地址」hint）+ 四配置回显 + 关闭钮（重开换 token 警示文案）
   - URL 展示相对路径（控制端不透 baseUrl，完整 URL 由用户拼主机——WH 批适配点 6 既定口径）；enable 成功后回显新 url
4. **i18n**：`ai:server.graph.webhook*` 键组 zh/en 双语（`src-react/i18n/locales/*/ai.json`）。
5. **测试**：graph-panel.test.tsx 扩用例——status 两态渲染（惰性拉取时机）/enable 提交载荷断言（含 fullAccess）/disable 调用/重开换 token 后 url 更新；IPC 通道注册面以 graph.api mock 隔离（Panel 测试不触 ipc 层，既有先例）。
6. **spec 外不动**：mirror face（桌面被控面无 graph 能力，无桥面需求）；无头端零改动；移动端留档。

## 2. 非目标（留档）

- 移动端 webhook 配置面（无图管理页，待移动端编排面成批时一并）。
- GraphEditorView 本地面零改动（本地 IPC 三通道早已有）。
- baseUrl 透出/绝对 URL 拼接（连接层无此透出面，收益低）。

## 3. 风险

- Popover 内表单交互态较多——沿用桌面既有受控组件风格；graph-panel 测试用 fireEvent/userEvent 先例照搬。
- enable 端点语义「重开即换 token」——UI 必须明示（防用户误触断掉外部集成）。

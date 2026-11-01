# provider 级默认上下文窗口设计 spec

日期：2026-11-01
状态：已批直接开工（对话内用户「需要继续」滚动授权；收敛清单留档项）
关联：contextWindow 空配置兜底 128K 批（2026-11-01-default-context-window——本批消解其风险：本地 4bit 量化部署真实窗口 < 128K 时，全局兜底仍会超窗报错）

## 0. 事实基线

- 用户库 6 模型分属 3 provider（oMlx 本地量化 ×3 / new-api 中转），contextWindow 全 NULL——真实窗口按部署分化（本地量化常见 32K，中转 GLM 128K），单值全局兜底无法覆盖分化。
- 仓内加列惯例：`ensureXxx` 启动幂等补建（artifact/监控表/graphRunNode 先例）——不走 v1 快照避免指纹变化触发旧库 drop 重建（用户 app 库有真实会话数据，不可清）。
- provider wire 链：provider.api.ts（Create/Update/Record）→ provider.repo create/update 显式列 → toRecord `...row` spread。

## 1. 本批裁定

1. **schema**：provider 表加 `contextWindow Int?`（schema.prisma + 注释声明 ensure 补建）；`ensureProviderColumns()`（pragma_table_info 查列 + ALTER ADD，SQLite 无 IF NOT EXISTS 形态）挂 Application 启动序。
2. **三层兜底链**：`effectiveContextWindow(modelRow, providerRow)` = model 显式 > provider 默认 > `DEFAULT_CONTEXT_WINDOW`(131072)；chat.service 三消费点（probeSendCost/streamAndPersist/getUsageBreakdown）统一换用。
3. **wire/表单**：ProviderCreateParams/UpdateParams/Record 加 `contextWindow?: number | null`（update 语义 null=清空、undefined=不修改，与 apiKey/extraHeaders 同款）；repo create 恒显式存（`?? null`）；ProviderDialog 数字输入 + 校验（整数）+ placeholder/hint（i18n zh/en 双语）。
4. **HD 遥控写面（providers-tap/providerSave）不加**：远端透出与写面留档（server 侧 provider 表无此列，两侧不对齐前不透出）。

## 2. 非目标（留档）

- server（apps/tianshu-server）schema 不加列：server 链保持两层兜底（model > 131072），drift 差异随 chat-runner 对过账。
- 模型家族查表预填（qwen/glm 按 modelId 识别）——provider 级已解分化，查表维护成本高不再做。
- MCP 多 server 总量预算（收敛清单另一留档项，另行立项）。

## 3. 风险

- 量化部署窗口由推理引擎启动参数决定（如 oMlx `--ctx-size`），provider 填错仍会超窗——hint 文案引导按部署实际填写。
- ensureProviderColumns 与 initDatabase 的执行序：挂 ensure* 族（initDatabase 之后），provider 表已由 v1 快照建立，ALTER 安全；新库首启 v1 建表后同样补列。

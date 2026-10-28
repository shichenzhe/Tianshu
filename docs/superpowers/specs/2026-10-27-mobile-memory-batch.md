# 移动端记忆进化批设计 spec

日期：2026-10-27
状态：spec 落盘（用户裁定「记忆进化需要」——推翻差集 C 类归类）
关联：mobile-scope-rulings 二裁 5；A5/A6/AR 批先例（桌面被控面专属）；automation CRUD 批同套路

## 0. 事实基线

- **存储在桌面 option 表**（PERSONALIZATION_KEYS，@tianshu/core 单源）：`memoryProfile`（四板块 markdown 串，8000 上限）/`memoryEnabled`/`memoryModelId`/`memoryLastCompiledAt`/`memoryLastError`。桌面 UI 经 app-settings 通道直读直写 option。
- **AI 操作在 MemoryService**（electron/domains/ai/personalization）：`personalization:applyMemoryInstruction`（指令→LLM 应用→落库 profile）与 `personalization:compileMemory`（手动整理）两 IPC；`createMemoryHandlers` 纯函数依赖注入（在途互斥 memory-inflight 模块级单例，与每晚调度器共享）；错误码五值 `MEMORY_DISABLED|MODEL_MISSING|COMPILE_FAILED|NO_MATERIAL|BUSY`（不 throw、码透传渲染层映射）。
- **无头端零覆盖**：无 memory 模块（20 modules 无一）——本批桌面被控面专属（记忆数据+每晚调度在桌面端），无头端不实现不报。
- **协议包零覆盖**：无 memory 契约。
- **桌面 UI 面**（MemoryGroup.tsx）：开关/模型选择/四板块视图+整段编辑/AI 指令/重置/导入合并/手动整理。

## 1. 本批裁定

1. **五端点桌面 face 专属**（ENDPOINTS.memory 组 + DESKTOP_CAPABILITIES 增 `memory`）：
   - `memory/get` {} → `{enabled, profile, modelId, lastCompiledAt, lastError}`（一次读全）
   - `memory/saveConfig` {enabled?, modelId?}（显式携带才写）
   - `memory/saveProfile` {profile}（**全量覆写**；空串=重置语义——移动端重置共用；桌面导入对话框的 merge 逻辑不进 wire，标注假设：导入面不进本批）
   - `memory/applyInstruction` {instruction} → MemoryServiceResult（码透传）
   - `memory/compile` {} → 同上
2. **协议收编**（memory-contract.ts 新文件）：`MemoryState`/`MemoryServiceResult`/`MemoryErrorCode`（五值枚举）。
3. **MemoryService 公开化**：registerIpc 内 handlers 提为实例方法（automation 批「内联体收拢」同款）——face tap 与 IPC 单源。
4. **face tap**（memory-tap.ts）：deps 注入（loadConfig/save/memoryService Pick/resolveDefaultModelId——modelId 缺省解析为 get 面回显 null 未配置）；get 直查、saveConfig/saveProfile 走 save；applyInstruction/compile 转 MemoryService。
5. **移动端 UI**（「我的」页新入口 → `/memory` 页）：
   - 开关（乐观翻转失败回滚）+ 模型选择（ModelPicker 复用）
   - 画像视图：MarkdownLite 渲染 profile 全文（不拆四板块 UI）；空态文案
   - AI 指令输入（单行+纸飞机；成功刷新画像）+ 手动整理按钮 + 重置（Alert 二次确认，覆写空串）
   - 错码五值 i18n 映射（memory:err.*）
6. **不做（留档）**：整段编辑、导入合并、每晚调度的移动端配置（桌面端行为自动继续）、无头端实现。

## 2. 测试

- 协议：ENDPOINTS/memory 入钉测试 + DESKTOP_CAPABILITIES 增 memory 断言。
- face：memory-tap 单测（get 聚合/saveConfig 显式携带/saveProfile 覆写/applyInstruction 码透传/未装配 5000）；routes.test 用例。
- mobile：store 防迟到（独立序号）+ 错码映射纯函数 + i18n 双语。

## 3. 分提交

1. `feat(protocol)`: memory 五端点 + MemoryState/Result/ErrorCode 契约收编。
2. `feat(face)`: MemoryService 公开化 + memory-tap + routes + capability + 装配 + 测试。
3. `feat(mobile)`: transport + store + /memory 页 + 我的页入口 + i18n + 测试。
4. 收口 prettier。

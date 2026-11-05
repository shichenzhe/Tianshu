# 2026-11-05 改进落地批纪要（优化改进过程记录）

> 本文记录 docs/design 12 篇技术方案「改进空间」节的落地执行全过程：从计划到 13 个实现任务、3 个修复环、1 次回归修复、终审修波的完整轨迹。各篇 §6 的 ✅ 标记是结果视图，本文是过程视图。
> 计划文档：`docs/superpowers/plans/2026-11-05-design-docs-improvements.md`；结果汇总：`docs/design/README.md`。

## 1. 任务链路

```
docs/design 12 篇技术方案（含 §6 改进空间 ~75 项）
  → 实施计划（10 批/14 任务，chat.service 等热点文件集中串行）
  → 13 实现任务（每任务：TDD 实现 → 独立复核 → 通过才进下一任务）
  → 3 个修复环（复核发现的 Important 级问题各 1 轮收敛）
  → 终审（全区间跨任务交互面核查 + ~36 条 deferred minor triage）
  → 终审修波（3+1 项收尾）
```

## 2. 任务-批次-commit 对照

| # | 批 | 任务 | commit | 结果 |
|---|---|------|--------|------|
| 1 | 1A | provider apiKey 解密收口（brief 4 处→实况 6 处裸读点）+ 加密降级状态条 | 59ea9f00 | review 通过 |
| — | 附 | e2e 遗留修复被代提交（见 §5 裁定 3） | 32a176de | 保留 |
| — | 附 | core tsconfig nodenext 回退被正式化（见 §5 裁定 3） | d9b4ee20 | 保留 |
| 2 | 1B | 监控页 host-route 化 + 主机页摘要卡 + server 事件 90 天裁剪 | 50fc70e6 | review 通过 |
| 3 | 1C | 图运行快照 + webhook 互斥 + notify 无头端降级标注 | 2249f375 | review 通过 |
| 3.5 | 修复 | Task 1 引入的 3 suite mock 失败（import 链 prisma-client 期读 app.isPackaged，全量跑绿系 mock 泄漏掩盖） | 7e36ba1f | controller 直验收 |
| 4 | 2 | 资料库桌面写侧向量化（vectorizeLibraryContent 收编 core）+ 递归切块 + library_search 语义版 | d1befe67 | review 通过 |
| 5 | 3A | 自动化重试指数退避（60/180/540s + classifyError 可重试面）+ 补跑参数化 + 每日 rollup | 6c1ca49b | review 发现 openapi 类型错 → 修复环 |
| — | 修复环 | Task 5 catchUpLimit openapi 类型 object→number | 70bd1584 | Round 1 收敛 |
| 6 | 3B | queryKey 主机隔离（实况 283 处改 hash 中心收口）+ protocolVersion 协商 + 直连明文警示 | c1d089aa | review 通过 |
| 7 | 4A | relay TOFU 指纹确认仪式（首连确认卡+确认后 wire 强制校验）+ 指纹常显 | 4e644049 | review 通过 |
| 8 | 4B | server 操作日志启用（配置驱动）+ 非 loopback 无 TLS 告警 + MCP 进监控聚合 | 1787a8cb | review 通过 |
| 9 | 5 | 模型能力矩阵 4 列 + 内置目录回填 contextWindow + 瞬态重试 + fallback + benchModel 测速 + 成本折算 + comfyui 分支 | 3dcb4af8 | review 发现 fallback 参数不自洽 → 修复环 |
| — | 修复环 | fallback 按备选自身参数/窗口构造（FallbackAttemptPlan）+ 备选不可用降级 | a2608dbf | Round 1 收敛 |
| 10 | 6 | 专家团成员埋点（llmCallEvent meta 列）+ memberReport 块（core+桌面+移动端三份同形）+ 截断丢失提示 | 6a60b9e3 | review 通过（首 dispatch 停滞，resume 收尾） |
| 11 | 7 | SKILL.md tools 声明 + MCP 折叠会话自适应 + toolPermission lastUsedAt 治理 + 审批参数级 pattern（元字符守卫 7 例红线） | 1b917a78 | review 通过（三安全红线核查） |
| 12 | 8 | 项目记忆沉淀（memory.md 双层上下文）+ 项目域三类审计 + 附件死链治理 + 失效挂载清理 | 07c4e17f | review 发现 memory.md 语义矛盾 → 修复环 |
| — | 修复环 | memory.md 保留无标记人工内容（方案 a）+ 回写失败留痕 + docs 措辞 | 26d08a33 | Round 1 收敛 |
| 13 | 9 | 记忆 userId 命名空间隔离（迁移三态不断忆）+ 注入预算裁剪 + 条目溯源逐条删除 + 「记住这个」+ 导出导入 | 1712db39 | review 通过 |
| 14 | 终验 | 三端全量测试 + 12 篇 ✅ 交叉抽查 + README 落地态更新 | 4a9bbf65 | 全绿/12/12 命中 |
| — | 终审修波 | 监控重试文案 + 价格校验文案 + 文件门 block 面不变量注记与集成测试 + fallback 尾缀落库 | b68690c2 | all addressed |

## 3. 修复环与回归记录（过程学习）

1. **Task 1 回归（7e36ba1f）**：解密收口新增的 import 链（provider-runtime→secret-field→master-key→prisma-client）在模块加载期读 `app.isPackaged`——无 electron mock 的 3 个 suite 单跑必炸；全量跑绿是其他 suite 先建立 mock 的泄漏掩盖。教训：**全量绿 ≠ 逐 suite 绿**，新增跨层 import 时核对测试隔离面。
2. **Task 5 修复环（70bd1584）**：`TaskRecord['catchUpLimit']` 索引访问类型使 `design:type` 元数据退化为 Object，openapi 发布成 `type:"object"`。教训：**DTO 装饰器用索引类型时必须显式 `type: Number`**。
3. **Task 9 修复环（a2608dbf）**：fallback 初版沿用主模型的参数与截断预算——「64K 主模型 fallback 8K 本地模型」组合以备选 400 收场，fallback 对典型降级组合实质失效。修复为 `FallbackAttemptPlan`（备选自己的 contextWindow/采样参数），截断按各 attempt 窗口重算。教训：**降级路径必须用降级目标自身的约束构造请求**。
4. **Task 12 修复环（26d08a33）**：memory.md 固定头邀请「人工编辑整理」，但合并重写只保留标记锚定的段——用户按邀请新增的内容下次交接静默消失。修复为保留无标记内容（用户版本胜出语义）。教训：**对用户可编辑文件，「承诺可编辑」与「机器重写」的契约必须一致**。
5. **Task 10 停滞**：首 dispatch 在 drift rebase 阶段被 watchdog 中断（600s 无进展），工作区保留半成品；resume 后一次收尾成功。教训：**长命令（drift rebase/全量测试）在 agent 内应拆步执行**。

## 4. 终审结论（全区间 opus 复核）

- **跨任务四热点互不破坏**：chat.service.ts（7 个 commit 触碰，T1 解密纪律被 T9/T10/T13 正确继承）、monitor-stats.ts（三任务加法叠加）、schema 迁移链（server 侧 1_→4_ 编号=执行序，双引擎镜像一致）、run-chat-stream（attempt 重构状态全局部）
- **drift manifest 13 处过账链式对账全部成立**（含两处语义收敛：server 侧向 mirror 收编）
- **i18n key 奇偶校验 0 差异**；dist 产物新鲜（server jest 全绿佐证）
- deferred minor ~36 条 triage：无 Critical、无跨任务恶化，全部确认挂账（README §挂账）；3+1 项用户可见/安全项入修波收掉

## 5. 执行裁定记录（controller rulings）

| # | 裁定 | 理由 | 若错的回退 |
|---|------|------|-----------|
| 1 | 主树直接执行（非 worktree） | 文档与代码同批一致；worktree 三坑（nativewind/server jest/dist）测试成本高；单会话串行无冲突 | 每批独立 commit 可 revert |
| 2 | 全任务串行（弃计划批内并行） | 同工作区 git index/测试真库/dist 并发写竞态 | 仅时长代价 |
| 3 | 两个遗留改动被 agent 提交（32a176de e2e 修复 / d9b4ee20 tsconfig 回退）保留 | 内容自洽、提交信息如实、单命令可 revert | `git revert 32a176de` / `git revert d9b4ee20` |
| 4 | Task 1 brief「四处」按实况 6 处全修 | 收口目标优先于 brief 字面 | — |
| 5 | Task 1 引入的 suite 回归立即插队修复（非挂账） | 污染后续每批验证基线 | revert 7e36ba1f |
| 6 | Task 9/12 的 Important 进修复环（reviewer 建议挂账时） | 功能正确性问题非润色 | 各自 fix commit 可 revert |
| 7 | 终审 3+1 项立即修波（reviewer 建议可并入下批） | 用户可见文案错误与安全不变量不应带病合并 | revert b68690c2 |

## 6. 数据与兼容影响

- **schema 变更**（发布前窗口直改 v1 快照，旧 dev 库业务表会被指纹守卫 drop 重建——发布前既定约定）：model 四列（capabilities/priceIn/priceOut/fallbackModelId）、automationRun.graphJsonSnapshot、automationTask.catchUpLimit、toolPermission（pattern/lastUsedAt）、llmCallEvent.meta
- **server 存量库**：四组成对迁移（1_→4_）+ 启动幂等补列自愈（graphRunNode→snapshot→catchUpLimit→capability→permission 依序 ensure）
- **协议增量兼容**：MemberReportBlock、SessionUsageBreakdown.truncated、RemoteInstanceInfo.protocolVersion、PROTOCOL_VERSION、SKILL_TOOL_GROUPS、permission pattern——全部可选字段，老端忽略未知不炸
- **行为变化**：旧 bash/write 整工具记忆行原为死行（从不被咨询）→ 现按用户当初「允许并记住」的承诺语义生效；fallback/重试期间零可见块才触发（流已出内容不重试）；TOFU 首连不再自动信任

## 7. 挂账去向

- 大工程类（checkpointer/HITL、sqlite-vec、E2E 双棘轮、OS 沙箱、chat.service 拆分、多主机并发会话、relay 多副本、会话分叉树、块 id 协议、专家知识库绑定、记忆语义检索化、GraphRAG/多模态/OTel）→ `README.md §挂账-大工程类`，建议单独立项
- 中小项（引用溯源 UI、记忆即时性、automation 时区/powerMonitor/分布式锁、workflow 编辑器体验、provider 导入预填、监控 trace 下钻/outcome 补行、移动端 TOFU/planView valid 等）→ `README.md §挂账-中小项`
- deferred minors ~36 条 → 终审 triage 确认挂账（无跨任务恶化），上两条已覆盖需 actionable 的项

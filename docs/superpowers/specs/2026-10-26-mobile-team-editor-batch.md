# 移动端专家团成员编辑面批设计 spec

日期：2026-10-26
状态：直接开工（事实面已核实，Explore 纠偏：桌面编辑器已完整存在，缺口在移动端）
关联：[[user-rulings-2026-10-26]]；专家团设计 spec（2026-10-11-expert-team-design.md）；A2 尾协议 members 透传

## 0. 事实基线

- **桌面已有完整编辑器**（`src-react/domains/ai/assistant/components/AssistantDialog.tsx`）：expertType 单专家/专家团切换、成员四字段（id kebab 调度标识/name/profession/systemPrompt）行动态增删、≤13 名、team→agent 提交 members:null；测试覆盖全（`tests/ai/assistant-dialog.test.tsx:238-481`）。**本批不重写桌面，桌面是回归基准。**
- **移动端缺口**：`apps/tianshu-mobile/src/app/experts.tsx:124-201` 的 `buildPayload()` 不含 expertType/members——编辑已有团队时服务端保留原值（不误删），但无团队切换/成员编辑 UI；市场安装例外（store 提交 expertType+members，experts.store.ts:414-435）。
- **协议已备**：`AssistantSavePayload` 有 expertType/members（`packages/tianshu-protocol/src/expert-contract.ts:36-58`）；face expert-tap 新建/更新/导入均透传（members 三态：undefined 保留/null 清/数组覆盖）。
- **校验单源**：`electron/domains/ai/agent/create-expert.ts` teamMemberSchema（id kebab 正则/团内唯一/≤13/name·profession 1-30/systemPrompt 1-20000）；无头端 expert-io.ts 同规则双份。
- **id 长度口径不一致**：teamMemberSchema 未限 id 长度，但 dispatch_member 参数 member max 64——超长 id 可落库却无法调度。

## 1. 本批裁定

### 1.1 移动端编辑面 v1（主）
1. ExpertEditorDialog 增 单专家/专家团 类型切换（i18n 双语，视觉同桌面口径）。
2. team 态成员编辑：四字段行动态增删（≤13 行），字段同桌面（id 调度标识 kebab/name/profession/systemPrompt）。
3. `buildPayload()`：team 态提交完整 `expertType:"team"+members`；agent 态提交 `expertType:"agent"`（编辑已有团队转单专家时显式 `members:null`——与桌面 team→agent 清列同语义）；编辑 team 表单回填成员。
4. **前端校验对齐桌面 create-expert 口径**：空团队拒、空 id 拒、kebab 正则、团内 id 唯一、name/profession 1-30、systemPrompt 1-20000、≤13；服务端 repo 仍为权威（前端报错仅提前拦截）。

### 1.2 一致性小债（主会话随批清）
- 成员 id 长度钉死 ≤64：teamMemberSchema（mirror create-expert.ts）+ 无头端 expert-io.ts 同规则双份同步加 max(64)，对齐 dispatch_member 参数上限；读面 parseTeamMembers 不重校验（既有超长数据不被读面拒绝）。
- 桌面 AssistantDialog 文件头陈旧注释（1-6 名 → 13）修正。

### 1.3 非目标
- 无头端 assistant/save 端点：无头运行时裁剪了团队展开，只补保存会造半成品——无头 save+团队运行另批明确扩大。
- 桌面编辑器重写/重构：已完整，不重做。
- 成员 id 自动生成/花名转拼音：桌面用户手填先例不变。

## 2. 测试与验收
- mobile：buildPayload 三态（新建 team/编辑回填/team→agent 清列）用例；校验纯函数用例（kebab/唯一/上限/长度边界）；组件用例（切换/增删行/13 上限）；既有 541 零红。
- mirror/server：id max 64 校验用例各一；既有 expert-io/assistant 测试零红。
- typecheck（根+mobile）+ prettier + 分提交。

## 3. 风险
- members 整数组覆盖语义：漏传保留旧值/误传 null 清列——buildPayload 三态用例钉死。
- 团队表单键盘体验（多行输入滚动）——RN 铁律行禁 flex-1。

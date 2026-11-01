# 审查余项全清批设计 spec

日期：2026-11-01
状态：已批直接开工（对话内用户「全部需要，使用 worktree 处理，处理完后自动合并主干」授权）
关联：双端交叉审查处置第 2/3/4 项（快修批另册 2026-11-01-desktop-audit-quickfixes）

## 1. 九项裁定与落地

| # | 项 | 落地 |
|---|---|---|
| ① | 注释债 ×3 | 文件五件正名（4 文件 sed）/CORE 组绑定目录前提/usage 死分支注释 |
| ② | server todo_write 三重字面量 + event-bus 对未入册 | 去重；manifest 新对（基线 66） |
| ③ | server loadSkill 护栏 + usage 内联版口径 | 补 NUL 拒读+字节截断（mirror 同款）；messages 经 truncateHistory+trim（与 core context-usage 同口径） |
| ④ | server 图保存无自愈 | parseGraphJson 补 normalizeGraph（core 单源直引）；测试期望 nodeCount 2→3（db 直造 fixture 除外） |
| ⑤ | server 工作流工具老六名 | 坍缩四件对齐 mirror（write 二合一/read 二合一，run 双件不动）；老名经 core tool-alias 归一历史回喂透明 |
| ⑥ | **server 安全门无装配（P0）** | config.yml `tianshu.security` 段（缺省 sandboxEnabled=true + 自定义规则面六字段）；ChatCoreModule onModuleInit 装配两门（闭包实时读 config；file 门 extraBuiltin 含数据根自我保护）；spec 4 用例 |
| ⑦ | 桌面图/自动化缺审批记忆 | resolveAutomationPermissions 加 rememberedTool 参（server F3 同签名）；automation-runner（任务 workspaceId）/graph-executor（挂任务时）注入 rememberedToolOf（chat 链同款查询） |
| ⑧ | 桌面自动化不注入 dataSafety | setAutomationDataSafety 模块级注入（event-bus 先例）；executeTask 内 opts 优先、缺省回落；Application 与 ChatService 第 5 参同款闭包一处装配三触发路径 |
| ⑨ | 桌面 library_search 缺失 | 新工具（关键词文件名检索，UI search 同款查询——server PL-2 向量版 library 集合无写入方恒空，向量版待写入批后统一）；kind=read、无工作空间白名单成员 |

## 2. 非目标（留档）

- server option 表安全中心面（server 以 config.yml 为口径，与 mirror option 表不同源——有意）。
- 向量语义 library 检索双端统一（待 server「library 写入批」）。
- drift：chat-runner 对（三层 vs 两层 contextWindow、⑥⑦⑧ 分叉）基线过账；display/workflow 工具对未入册（workflow 已实质同构四名，display 零分叉——低优先）。

## 3. 验证

mirror vitest 4630 过 0 挂；server jest 853 过 0 挂；typecheck 0 错；prettier 干净；drift 52 对 0 告警。
事故记录：批内遭工作区周期性 reset 两次——分项 commit 纪律保住主体，未提交修正重放恢复（一次重复叠加由全量断言去重收尾）。

# 桌面审查快修批设计 spec

日期：2026-11-01
状态：已批直接开工（对话内用户「第一点先做」授权；双端交叉审查报告处置第 1 项）
关联：双端交叉审查（对话内，chat 域 + 图/自动化/库/安全域两份报告）

## 0. 事实基线（审查发现，均经实证）

- editAndResend 重写只保留 image 块，skill_ref 静默丢弃（注释自称与 send 落库结构对齐，实际 send 是 `[skill_ref…, text, images…]`）。
- AutomationScheduler.start 的 `void recoverInterruptedRuns()` 无 catch（server 同款已修）。
- 消息排序全 `orderBy createdAt`（chat.service 4 处 + session.repo 2 处 + 摘要轮 desc 取末条），SQLite 毫秒精度同毫秒双消息可乱序；server 全 `id asc`。
- browser 四件（snapshot/navigate/click/type）执行按 sessionId 解析 GuestControl 与绑定目录无涉，却被无工作空间过滤连带剔除（server 桥版常驻）；未登记分叉。
- 预存红 ×2：skill_ref 批给 sessionSend 加第 7 参 skillRefs，chat-route/files-route 两处断言未同步（主树同基线复跑确认非本批引入）。

## 1. 本批裁定

1. **skill_ref 保留**：editAndResend 重写保留块序 `[skill_ref…, text(新), images…]`（类型 SkillRefBlock from @tianshu/protocol）。
2. **scheduler catch**：`recoverInterruptedRuns().catch(Log.error)`（server 同款语义）。
3. **排序改 id**：仅消息类查询（chat.service 5 处 + session.repo 2 处）；toolPermission/workspace/artifact 非消息排序不动。测试 mock messageFindMany 同步认 orderBy.id。
4. **browser 白名单**：无工作空间过滤加 `startsWith("browser_")`（与 mcp__ 前缀同 idiom）。
5. **预存红顺手修**：两处 sessionSend 断言补第 7 参位（纯测试期望同步）。
6. 工作区周期性 reset 事故重放：本批改动曾被吃（分段自提交纪律执行中恢复，四 commit 粒度）。

## 2. 非目标（留档）

- library_search 桌面工具化、图/自动化审批记忆查表、dataSafety 注入（处置第 2/3 项另行立项）。
- server 侧问题（安全门装配 P0、工作流工具名、usage 内联版等）——另行批。
- 注释债（FILE_TOOLS 五件、CORE_TOOL_NAMES 表述、usage null 死分支）——顺手项未入本批。

## 3. 验证

vitest 全量 4602 过 0 挂（含新增：skill_ref 编辑保留用例、browser 白名单断言、三处工具集名单更新）；typecheck 0 错；prettier 干净；drift 无告警。

# 移动端项目详情页补全（纯前端 6 项）设计

日期：2026-11-01（批 ②，用户裁定范围：只做纯前端就绪项，不动 wire 协议）

## 背景

三端功能比对（2026-11-01）结论：移动端项目域 wire 面已就绪但 6 处
「store+wire 就绪、只差 UI」或「wire 已支持、载荷未传」的半成品。本批
全部纯移动端前端收敛，零协议/服务端改动。

## 六项

1. **事项删除**：`PlanItemDialog`（编辑弹窗）增删除入口（Alert 二次确认
   → `project.store.removeItem`——store+wire planItem/delete 均就绪，
   此前移动端删不掉任何计划事项）。
2. **状态快捷流转**：计划列表组内行（或长按菜单）提供状态切换
   （`project.store.moveItem` 就绪零调用——不做拖拽（移动端形态不适），
   做行内快捷切换：未开始/进行中/已完成/已阻塞四态 chips）。
3. **「我的任务」搜索框**：`projects/index.tsx` 我的任务 Tab 渲染
   `tasksKeyword` 输入框（store 字段+`filterMine` 参数均就绪，此前输入框
   未渲染）。
4. **项目任务降级编辑修复**：我的任务 Tab 行点击项目任务时当前以
   `projectId=null` 降级为本地任务编辑（字段子集）；改为携带真实
   `projectId` 打开全字段弹窗（处理人/日期/自定义字段/附件区）。
5. **模版创建**：新建项目对话框增模版选择（对齐桌面 4 内置模版——
   模版清单为纯本地数据；`project/create` wire 已支持
   `templateKey`/`welcomeMessage` 却未传）。
6. **指令 Markdown 渲染**：详情页「关于」Tab 指令区由纯文本改
   `MarkdownLite` 子集渲染（组件现成）。

## 非目标

- 不动 wire 协议面（挂载编辑/视图 CRUD/字段定义/资产上传——延后批）。
- 不做对话入口（sessionId 消费）与定时任务面板。
- 不做看板/日历/甘特视图（移动端屏幕形态不适合）。

## 验收

- `npm run typecheck -w apps/tianshu-mobile` 通过。
- `npm run test -w apps/tianshu-mobile` 通过（新增：状态流转/降级编辑
  相关纯函数或 store 用例；模版清单双语 key 走 i18n）。
- 全部新文案 zh-CN/en-US 双语同步（i18n 红线）。

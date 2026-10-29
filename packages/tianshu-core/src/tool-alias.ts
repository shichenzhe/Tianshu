/**
 * 工具名别名层（2026-10-29 用户裁定「参照业界主流精简工具名」）：
 * 内置工具全面改名（核心 8 名 Unix 化 / plan 五件坍缩 todo_write+todo_read /
 * workflow 六件坍缩 write+read+run 双件 / 域名短化），历史 blocks 存
 * toolName（spec §20 项 C 曾据此禁改名）——本模块以老名→新名单向映射
 * 兑现反向裁定：历史回喂/编辑重发的老名 tool_call 经 canonicalToolName
 * 归一后由新名工具执行，DB 历史数据不迁移。
 *
 * 纯数据零依赖（三端单源）：electron/src-react 经 alias 直引源码，
 * tianshu-server 经 workspace dist；消费点——
 * ① run-chat-stream ToolNode 子类（模型发老名 → 新名分发，绑定面只出
 *    新名 schema，46 工具双列不可见）
 * ② tool-registry registry.find/filterDisabledTools（toolPermission DB
 *    存老名，禁用语义跨改名延续）
 * ③ src-react 渲染匹配（老 blocks 的 toolName 兼容显示）
 * 注意：plan 五件参数形状不同（单条 vs 全量列表），老名仅做名字级路由，
 * 参数不匹配由 zod 报错让模型按新 schema 自纠；workflow 四件参数超集
 * 兼容（create/update/list/get 老参数均为 write/read 子集），老名调用
 * 完全透明。
 */

/** 老名→新名（20 老名 → 15 新名；browser 四件/技能专家域未改名无别名） */
export const TOOL_NAME_ALIASES: Readonly<Record<string, string>> = {
  // 核心 8 名（Claude Code/Unix 风单动词）
  read_file: "read",
  write_file: "write",
  list_dir: "ls",
  search_files: "grep",
  delete_file: "rm",
  run_command: "bash",
  web_fetch: "fetch",
  open_browser: "browse",
  // plan 五件 → todo_write/todo_read（Claude Code TodoWrite 全量写模式）
  plan_create_item: "todo_write",
  plan_update_status: "todo_write",
  plan_append_summary: "todo_write",
  plan_list_items: "todo_read",
  plan_get_item: "todo_read",
  // 域名短化
  create_automation_task: "create_schedule",
  recommend_experts: "recommend_expert",
  dispatch_member: "dispatch",
  // workflow 六件 → write/read 二合一（run 双件未改名）
  create_workflow: "workflow_write",
  update_workflow: "workflow_write",
  list_workflows: "workflow_read",
  get_workflow: "workflow_read",
};

/** 老名归一为新名；新名/未知名/mcp__ 前缀原样透传 */
export function canonicalToolName(name: string): string {
  return TOOL_NAME_ALIASES[name] ?? name;
}

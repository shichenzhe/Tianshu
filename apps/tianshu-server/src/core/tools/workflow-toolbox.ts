/**
 * 工作流+展示工具实例传递盒（F1/F2 2026-10-29）：GraphModule 启动工厂
 * 装配（installWorkflowTools——同时注册聚合 registry 供 graph LLM 节点
 * collectTools 取用），ChatRunnerService 按 mirror 场景门控取
 * （getWorkflowToolbox）。为何不经 chat-runner 直接 import registry：
 * 既有静态环②（library-tools 注释备案：chat-runner → library-tools →
 * vector-store → executor-runtime → chat-runner）——chat-runner 顶部引
 * registry 会补全「registry → library-tools」半初始化回边（实证：
 * LIBRARY_SEARCH_TOOL 落 undefined 进注册表炸 find）。本模块零依赖
 * （仅类型），环上不新增节点。
 */
import type { ToolDefinition } from './tool-definition';

let installed: ToolDefinition[] | null = null;

/** GraphModule 工厂装配口（幂等：重复 install 覆盖） */
export function installWorkflowTools(defs: ToolDefinition[]): void {
  installed = defs;
}

/** chat 侧取用（未装配=测试态未挂 GraphModule，返回空集不注入） */
export function getWorkflowToolbox(): ToolDefinition[] {
  return installed ?? [];
}

# React Flow 可视化编排画布设计

> 上游需求：用 React Flow 重构编排编辑器为工作流式画布交互（拖拽/连线/
> 属性面板），替换结构化表单模式。方案 A：画布主模式 + 右侧属性面板 +
> JSON 高级模式。后端零改动。

## 0. 已确认决策

| 问题 | 结论 |
|------|------|
| 依赖 | `@xyflow/react@^12.12.0`（peer react>=17，React 19 兼容；ESM+CJS） |
| 模式 | 画布为默认主模式；JSON 源码保留为顶栏次要切换（高级用户/兜底，双向同步沿用现有） |
| 坐标持久化 | `GraphNode.position: {x,y}` 可选字段，随 graphJson 落库；旧图零迁移 |
| 自动布局 | 无坐标节点自写分层布局（拓扑层级 BFS × 层内垂直排开），不引 dagre |
| END 可视化 | 画布右缘不可删虚拟节点（边 `to:"END"` ⇄ 连到它）；START 不设实体（入口=无入边，派生徽标） |
| 条件边交互 | branch 节点按 branchOptions 每选项一个 source handle，从该 handle 拉线即建带 condition 的边 |
| 属性面板 | 选中驱动：节点（复用现有 llm/code 分流字段表单）/边（条件查看改）/未选中（图级属性） |
| 运行态 | 不上画布（trace 仍在运行历史/记录视图；画布运行高亮 v2） |
| GraphEdgeEditor | 下拉形态退役（被连线交互替代）；GraphNodeEditor 字段表单重构进属性面板 |

## 1. 数据模型

`graph.schema.ts`：GraphNode 两分支（llm/code）各加可选
`position: z.object({ x: z.number().finite(), y: z.number().finite() })`。
validateGraph 不校验坐标语义（重叠/越界不拦）；执行器/编译器忽略 position。
后端、数据库、IPC 零改动。

## 2. 画布交互（GraphCanvas + NodeCard/EndMarker）

- ReactFlow：`nodes`/`edges` 受控（经 graph-canvas-model 与 GraphJson 双向
  映射）；onNodesChange 只消费 position/selection/changes，dimensions 类
  change 由 RF 内部管理
- NodeCard：类型徽标（AI=Sparkles 系语义色/Code=Terminal）+ 名称 + 摘要
  （AI：模型名 or 待选提示、branch 选项 chips；Code：语言 + 脚本首行）；
  入口徽标（无入边派生）；样式全语义 token（bg-card/border-border/
  selected 时 ring-primary）；宽度固定档（~220px）
- Handles：target 左侧 ×1；source 右侧 ×1（普通）或 ×branchOptions.length
  （branch，每 handle 顶部对齐选项标签）；handle id 编码
  `branch:<value>` / `plain`
- onConnect 规则（graph-canvas-model 纯函数 `connectEdge(graph, conn)`）：
  - source handle `branch:<v>` → 建 `{from,to,condition:{type:"branch",value:v}}`
  - `plain` → 建无条件边（多条不同 to 的无条件出边允许——fan-out 语义，
    与 schema/编译器现状一致）
  - 完全重复边（同 from+to+condition）/自环 → 拒；to 为 END 虚拟节点 →
    `to:"END"`
- 节点创建：工具栏两按钮（视口中心 + 累计偏移落点）；Delete 删除选中
  节点（级联删边）/边；入口节点删除后入口自动转移（校验兜底可保存前拦截）
- MiniMap + Controls（缩放/fit）+ Background dots；`@xyflow/react/dist/style.css`
  全局引入一次；框选默认开

## 3. 属性面板（NodePropertiesPanel）

- 右侧 ~300px，选中驱动三分支：节点（现有 GraphNodeEditor 字段表单全量
  搬入：kind 切换/id 锁定/llm 或 code 分流字段 + 顶部删除钮）/边（from/to
  只读、branch 源时条件下拉 ⊆ branchOptions、删除）/未选中（图名称/描述/
  inputSchema 变量 StringListInput）
- onPatch/onSwitchKind/onRemove 回调与画布共享同一 GraphJson 状态源
  （GraphEditorView 持有，现有 reducer 路径不变）

## 4. 校验联动与保存

- 顶部错误列表保留；带 nodeId/边信息的错误点击 → `setCenter` 定位 +
  节点高亮 2s（uniqueEntry/danglingEdge/branchOptionsRequired/code 节点
  script 缺失等）
- 保存门槛（校验过 + draftChanged）/版本乐观锁/试运行/运行历史顶栏
  全部不动；拖动坐标变化经序列化自然计入「有变更」
- 模式切换 canvas⇄json：现有 parseOrKeep 门禁沿用（JSON 非法禁切回）

## 5. 组件结构与数据流

```
src-react/domains/ai/orchestration/
├── components/
│   ├── GraphCanvas.tsx          # ReactFlow 编排（受控 nodes/edges/连线/删除/小地图）
│   ├── nodes/NodeCard.tsx       # 自定义节点（AI/Code 两形态 + 入口徽标 + handles）
│   ├── nodes/EndMarker.tsx      # END 虚拟节点（draggable=false/deletable=false）
│   ├── NodePropertiesPanel.tsx  # 选中驱动属性面板（含边面板分支）
│   └── GraphJsonEditor.tsx      # 保留（JSON 模式）
├── lib/
│   ├── graph-canvas-model.ts    # 纯函数：toCanvas/toGraph 双向映射/connectEdge/
│   │                            # autoLayout（分层确定性）/endMarker 常量
│   └── graph-editor-model.ts    # 既有（newNode/switchNodeKind/校验/序列化）不动
└── views/GraphEditorView.tsx    # 改造：mode="canvas"|"json"；右面板布局；顶栏不动
```

数据流单向：GraphJson（唯一源）→ toCanvas → RF 展示；交互事件
（onConnect/onNodesChange position/面板 onPatch）→ 纯函数 → setGraph。

## 6. 错误处理

- 坐标 NaN：zod `.finite()` refine（schema 层拒非法 JSON）
- ReactFlow 样式/组件 lazy 失败：ErrorBoundary 提示 + 仍可切 JSON 模式编辑
- 旧图无坐标：装载时 autoLayout 计算并立即视为草稿坐标（保存时落库）
- 画布容器尺寸为零（Tab 未激活）：RF `fitView` 延迟到可见后执行

## 7. 测试（Vitest）

- **graph-canvas-model（重点）**：⇄映射往返一致（含 position/condition/
  END 虚拟节点）；autoLayout 确定性（同图同布局、无坐标全覆盖、分支图
  分层正确）；connectEdge 规则矩阵（branch/plain/重复/自环/END）；坐标
  写回（toGraph 保留拖动后位置）
- **schema**：position 可选/非法值拒绝（NaN/Infinity）；旧图零迁移回归
- **GraphEditorView jsdom 冒烟**：canvas 默认渲染节点卡片、模式切换
  canvas⇄json 双向同步、选中节点面板出现字段
- ReactFlow 深交互（拖拽/连线手势）不做 jsdom 深测——手工冒烟清单
- 既有全量测试零回归

## 8. 手工冒烟清单（交付时给出）

① 旧图打开自动布局正常；② 拖节点→保存→重开位置保持；③ branch 节点
多 handle 拉线自动带条件标签；④ END 连线/删除边；⑤ 属性面板三种态
（节点/边/未选中）；⑥ 错误点击定位高亮；⑦ JSON 模式往返同步；
⑧ 试运行与运行历史不受影响。

## 9. 范围外（v2 议题）

画布运行态高亮（trace 回放）、分组/注释节点、撤销重做、边路由手工调整、
dagre 高级布局、移动端触控优化。

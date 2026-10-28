# 天枢共享 core 重构设计（协议包 + 核心逻辑包）

- 日期：2026-10-17
- 状态：待用户确认
- 前置：`2026-10-16-tianshu-server-design.md`（§12 假设 6 双仓同构债务的本设计即其演进解）
- 用户指令（2026-10-17）：服务端刚做无人用；按与客户端共享 core 方式重构；先协议包、再核心逻辑包；核心逻辑以客户端（mirror）为主

## 1. 背景与目标

一期落地后两仓各持一份同构代码（chat 纯逻辑 9 文件逐字复制、协议类型同构重写、Prisma 业务表复制），漂移已实际发生：终审 ledger 记录 4 处语义分歧 + 1 个 bug 双仓各修一遍（模型三级兜底）。目标：**以 mirror 为 source of truth 抽共享包，tianshu-server 重构为包消费者，消灭可消灭的双份**。

不删仓重写的理由：服务端 NestJS 层（modules/relay/commons）与双份问题无关且经终审 E2E 11/11，重构替换代价 < 重写。

## 2. 目标结构

```
mirror 仓（source of truth）
├── packages/
│   ├── tianshu-protocol/   # 协议包：纯类型 + 常量，零运行时依赖
│   │   └── src/（ServerEvent/CAPABILITIES、relay 帧类型、逻辑端点常量、
│   │           blocks/chunk/ChatSendParams 等「线上契约」类型）
│   └── tianshu-core/       # 核心逻辑包：纯逻辑实现
│       └── src/（blocks.ts、history-truncate、tool-output-trim、param-merge、
│               error-classify、context-usage、time-context、scenario-prompt、
│               expert-catalog、run-chat-stream[自 chat.service 剥出]）
│       peerDependencies：@langchain/core、zod（两仓各自已装，不引入新拷贝）
├── electron/、src-react/   # 消费方：import "@tianshu/protocol" / "@tianshu/core"
└── vite/vitest/tsconfig alias：@tianshu/* → packages/*/src

tianshu-server 仓（消费者）
├── dependencies： "@tianshu/protocol": "file:../mirror/packages/tianshu-protocol"
│                  "@tianshu/core": "file:../mirror/packages/tianshu-core"
├── 删除：src/protocol/（server-event.ts）、src/core/chat/ 全部副本
└── import 改指包（Jest moduleNameMapper 同步）
```

**消费形态的关键裁定**：

- mirror 侧走 **alias**（vite resolve + vitest + tsconfig paths 三处登记），**不进 package.json dependencies**——依赖分区铁律（dependencies=vite external 互锁，现 4 包）零触碰，rolldown 直接内联包源码（纯 TS 无运行时依赖，无 CJS 互操作风险）。
- tianshu-server 侧走 **npm file: 依赖**（无 external 互锁约束，nest build 全内联 dist）。包带 `tsc` 构建产出 dist + main/types；mirror 改包后 tianshu-server 重装同步（`npm run sync:core` 脚本封装，README 写明开发流）。
- 包不发布 npm（私有 file:/alias 消费）；两包在 mirror 仓内**无独立单测目录**——测试随消费方跑（mirror 的 tests/ 已覆盖纯逻辑，服务端 Jest 复用其用例副本）。

## 3. 与一期实现的差异点

| 项 | 一期 | 本设计 |
|---|---|---|
| 纯逻辑 9 文件 | 双份逐字复制 + README 来源表 | 单份在 `@tianshu/core`，双仓 import |
| runChatStream | mirror 在 chat.service.ts 内；server 剥出版 | 从 mirror chat.service **剥出**为包内独立文件（以 mirror 实现为准，server 删其版本） |
| 协议类型 | 双份同构（「双改」纪律） | 单份在 `@tianshu/protocol` |
| blocks/chunk 类型 | mirror 在 src-react chat.api.ts + electron blocks.ts；server 复制 | 搬入协议包；chat.api.ts 与 blocks.ts 原位置改为 re-export（渐进兼容，import 链不强制全改） |
| 工具集/model 工厂/session 仓储 | 双份 | **维持双份**（工具集含 Electron 耦合：审批/IPC/文件门回调；接口注入化成本高、收益低）——纳入漂移巡检（§5） |

## 4. 语义对齐（终审 ledger 的 4 处分歧逐条裁决）

| 分歧 | 一期现状 | 裁决 | 理由 |
|---|---|---|---|
| session/query 排序 | mirror lastMessageAt / server updatedAt | 对齐 **lastMessageAt**（server 改） | 会话按活跃排序语义正确，mirror 为准 |
| keyword 匹配 | mirror includes（敏感）/ server LIKE（ASCII 不敏感） | 对齐 **mirror includes**（server 改） | 语义一致优先；搜索体验优化另行立项 |
| create 缺省 workspace | mirror 不自建 / server 自建默认 | **plan 阶段查 mirror 实现后定**；倾向 mirror 行为为准，server 侧以初始化默认 workspace 满足外键语义 | 消除「交集编程」负担 |
| archived 会话 send | mirror 5000 / server 202+session.error | **保留 server 行为**（例外），差异写入协议包文档注释 | HTTP 语义正确；客户端按事件流处理不受影响 |

## 5. 漂移巡检（覆盖剩余双份）

`packages/tianshu-core/scripts/`（或 mirror scripts/）加 `check-drift.ts` + manifest：登记仍双份的文件对（服务端工具集/model 工厂 vs mirror agent/provider），逐对比对（忽略 import 路径与注释的归一 diff），不一致即非零退出。mirror `npm run check:drift`，可挂 CI。

## 6. 阶段划分

- **Phase 1 协议包**：建包 → mirror 接入（server 域 protocol.ts / server-face 帧类型改 import）→ tianshu-server 接入（删 src/protocol/ 改 file:）→ 双仓测试绿。
- **Phase 2 核心逻辑包**：建包（mirror 9 文件搬入 + runChatStream 剥出 + chat.api/blocks re-export）→ mirror 全量回归 → tianshu-server 替换（删 src/core/chat/，chat-runner 改 import 包）→ 语义对齐两处（排序/keyword）→ 双仓全量测试 + E2E 冒烟（真模型）。
- **Phase 3 巡检与收尾**：check-drift 脚本 + manifest（覆盖工具集/model 工厂）→ README 更新（协议速览指向包、开发流 sync:core 说明）→ 终审。

## 7. 假设与偏离

1. 工具集/model 工厂/session 仓储不入包（Electron 耦合）——一期内维持双份+巡检，接口注入化待二期评估。
2. 包不做独立单测目录（测试随消费方）；不做 npm 发布。
3. mirror 原类型位置用 re-export 兼容层（不为抽包大改全部 import 链）；服务端无人用，其 import 链一步到位全改。
4. 协议包升级 `create 缺省 workspace` 裁决在 plan 阶段先查实现再定（不阻塞 Phase 1）。
5. 铁律不触碰：mirror dependencies 不增删、external 白名单不动；tianshu-server dependencies 增两个 file: 条目（其仓无互锁约束）。

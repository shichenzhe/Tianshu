/**
 * @tianshu/core：天枢双仓共享核心逻辑包（chat 纯函数实现）。
 * - mirror 仓内经 alias 消费 src 源码（vite 顶层/主进程、vitest、tsconfig
 *   paths 四处登记——同 @tianshu/protocol，vite-plugin-electron 的 main
 *   构建是独立实例，顶层 alias 不传递）；
 * - tianshu-server 仓经 npm file: 消费 dist 产物（build 前置协议包构建，
 *   其 d.ts 经本包 tsconfig paths 解析——src 源码映射会把协议源文件拉入
 *   编译范围触发 rootDir 溢出，故映射 dist）；
 * - 类型/常量契约在 @tianshu/protocol，本包只承载实现；包内模块仅依赖
 *   协议包 + @langchain/core + @langchain/langgraph（runChatStream，RC-T4）
 *   + zod/date-fns（graph-schema/schedule-schema，GA-T2）+ 包内相对
 *   （闭包自洽准入，RC-T3/T4、GA-T2）。
 */
export * from "./blocks";
export * from "./monitor-events";
export * from "./monitor-stats";
export * from "./workspace-files-scan";
export * from "./history-truncate";
export * from "./tool-output-trim";
export * from "./param-merge";
export * from "./error-classify";
export * from "./time-context";
export * from "./scenario-prompt";
export * from "./agent-chunk-emitter";
export * from "./run-chat-stream";
// GA-T2：编排纯逻辑 + graph/schedule zod schema 全量入包（controller
// ruling 3；schedule-schema 为 schedule.ts 的闭包随行件）
export * from "./graph-schema";
export * from "./graph-inputs";
export * from "./schedule-schema";
export * from "./graph-compiler";
export * from "./graph-prompt";
export * from "./graph-http-guard";
export * from "./crypto-envelope";
// 备份档口令加密（安全审查 2026-11-02 剩余待办 1）：scrypt 派生 +
// AES-256-GCM 档级流式加密，tsbak:v1 自描述头（旧明文档零迁移兼容）
export * from "./backup-archive-crypto";
export * from "./schedule";
// 批3A（automation-scheduled-tasks §6-4/6-6）：重试指数退避 + 错误分类
// 可重试面 / 每日统计 rollup 聚合桶——双端调度器同构消费单源
export * from "./automation-retry";
export * from "./automation-rollup";
// E2E-T1：relay 端到端加密核心（X25519+HKDF+GCM 信封+重放窗口，纯
// node:crypto；信封/握手 kind 常量为跨仓单份 wire 契约）
export * from "./e2e-crypto";
// relay 多租户（spec §5.4）：access token 续期阈值判断纯函数，四端共享
export * from "./relay-credential";
// PL-1：个性化 prompt 拼接 + config 纯常量段入包（server 读侧与 chat
// system 注入同源消费；option 行解析 fromAppOptions 含 option-store
// 依赖留消费方，不随行）
export * from "./personalization-config";
export * from "./personalization-prompt";
// A7：计划视图筛选引擎 + 日期基础下沉（桌面 src-react 改 re-export，
// 移动端消费 dist；农历/月历网格/甘特留桌面本地，lunar 不进本包）
export * from "./plan-view-engine";
export * from "./plan-date";
// A2：专家市场静态数据（12 分类分片 + 聚合 + toCreateParams 纯函数，
// 零依赖纯数据——聚合进 barrel 安全：不拖 Node 侧依赖进 renderer；桌面
// src-react 原位 re-export，被控面 marketList/marketDetail 端点消费）
export * from "./expert-market";
export * from "./tool-alias";
// GA 系（混合检索 Task 1）：检索纯逻辑入包——tokenize/rankBm25/rrfFuse
// （FTS5 否决 pivot 内存 BM25），mirror vitest 单测 tests/core/ 同源消费
export * from "./retrieval";
// 批2（library-rag §6 P0-1/P1-2）：资料库写侧向量化编排收编三端单份
// （db/embed/upsert 必填注入面，两端薄壳接线）——分块本体即上项 chunkText
export * from "./library-vectorize";
// 批5（provider-model §6 项 1b/5/7）：内置模型目录（窗口/价格/能力 +
// effectiveContextWindow 四层兜底）与模型类型启发式（桌面/移动双份收编）
export * from "./model-catalog";
export * from "./model-type";

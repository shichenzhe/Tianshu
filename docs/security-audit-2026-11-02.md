# 安全审查报告与待办（2026-11-02）

三路并行审查（凭证存储加密 / 网络传输链路 / 其它攻击面）覆盖桌面端、无头服务端、移动端与共享包。本报告记录审查结论、已修复项（五批 25 项）与剩余待办。

## 一、审查发现总览

### 高危（11 项——已全部处置）

| # | 发现 | 处置 |
|---|---|---|
| 1 | 全仓零 OS 凭证保护（safeStorage/keychain 未用），所有凭证明文落库 | 批三·A/B：core AES-256-GCM 信封单源 + safeStorage 主密钥 + 双端读写点接入 |
| 2 | 移动端 relay 传输层完全未实现 e2e——业务帧全明文过 relay | **待办**（需 RN X25519 选型） |
| 3 | e2e 默认 auto + 2s 握手超时静默降级明文 | 批一：新建连接缺省 required + 降级入审计链 |
| 4 | TOFU 指纹自动回填无用户确认 | **待办**（需 UI） |
| 5 | relay 全凭证走 WS URL query + 无 TLS | 批二：控制端拒绝公网明文 ws://；**TLS 待办** |
| 6 | 备份档=未加密全量凭证导出且含 .jwt-secret | 批三·B：jwt-secret 出档+恢复轮换+目录权限；**口令加密待办**（需 UI） |
| 7 | default 档 bash 免审批 + 命令黑名单首 token 伪装绕过 | 批一：网络外发 13 类默认纳 cmdAsk + 命令位序列全比对 |
| 8 | 渲染层 window.open→openExternal 无协议白名单 | 批一：非 http(s) deny + file:// 导航收窄渲染入口 |
| 9 | 图编排 HTTP 节点零 SSRF 校验（URL 可被 webhook/LLM 模板化） | 批一：字面 IP/协议守卫；尾批 F：DNS 解析级分类 |
| 10 | TIANSHU_TOKEN 未设时三层 fail-open（BackupGuard 静默提权 admin） | 批一：豁免门控 + 非 loopback 无 token 拒绝启动 |
| 11 | 连接 token 家族明文存 option 表（含 E2E 静态私钥） | 批三·B：字段级信封全覆盖 |

### 中危（已在批一/二/三/尾批收口）

SSE 冗余 token query / webhook token 落日志+prometheus / 握手 token 打 stdout / 三处读取守卫不跟 realpath / terminal 零审计 / 消息载荷原文落日志 / workspace:readFile fullAccess 绕授权门 / SSRF 清单过窄 / 速率限制缺失 / server webhook token 明文 / 弱默认凭证与固定重置口令

### 过程中揪出的批外真 bug（6 个）

P1-A 通道白名单漏登记 / mobile skill_ref 渲染缺口 / drift 脚本 skip 条目崩溃 / webhook 解封 Promise 未 await / master-key 临时密钥持久化语义 / server S5 漏接

## 二、已修复批次索引（git log --grep=安全 可查）

| 批次 | 合并提交 | 项数 |
|---|---|---|
| 批一（高危速堵） | ac109719 | 5 |
| 批二（网络/日志/读取面） | e63731d1 | 7 |
| 批三·A（凭证加密体系） | 4e3bd822 | 4 |
| 批三·B（连接 token + 备份面） | 5411d827 | 2 |
| 尾批 E（dataSource/读取收敛/弱默认） | 598d0023 | 3 |
| 尾批 F（DNS 级 SSRF/速率限制/server 对齐） | fecb84a3 | 4 |
| 批 G（备份档口令加密 + master-key 递归 bug 随修） | 1d7630e4 | 剩余待办 1 |
| 批 H（移动端 relay e2e @noble 路线 + token 迁 secure-store） | 10b80659 | 剩余待办 2 |
| 批 I（relay TLS 可选项 + 首帧鉴权双轨） | ad272143 + 0ad95c21 | 剩余待办 3 |

## 三、剩余待办（3 项——已全部落地，2026-11-02 收口）

### 1. 备份档口令加密（✅ 批 G，1d7630e4）

core 新增 `backup-archive-crypto`（scrypt N=2^16 自描述档头 + AES-256-GCM 档级流式加密，`tsbak:v1` 头 + AAD 绑头行 + 错误二分）；本地导出/恢复链接入（口令可选，旧明文档零迁移）；导出口令弹窗（两次一致防手滑）+ 恢复弹窗口令框；随修 `master-key.ts` safeStorageAvailable 递归 bug（恒 false 致 OS keychain 保护从未生效）+ 存量 hex:v1 读时升级。

### 2. 移动端 relay 接入 e2e（✅ 批 H，10b80659）

Expo Go 流程下 react-native-quick-crypto 不可行（需 dev build），走纯 JS：`@noble/curves/ciphers/hashes` + expo-crypto 随机源；mobile 本地 Uint8Array 第二实现（wire 与 node 原实现字节级兼容，交叉向量测试锁定互操作）；relay-transport 补完整握手/信封/auto-required/TOFU 状态机（蓝本桌面 E2E-T3）；连接 token 迁 expo-secure-store（AsyncStorage 只存剥离形态，旧档自动迁移）；表单补 ws:// scheme 门禁（B7 同款）。e2e wire 契约上收 @tianshu/protocol（三端单源）。**被控端可收敛全局 required 的约束已解除**（后续独立裁定）。

### 3. relay 原生 TLS + 凭证出 URL query（✅ 批 I，ad272143 + 0ad95c21）

- TLS：`--cert/--key` 成对传入即 https/wss 监听（客户端零改动）；既定架构仍为反代终止 TLS，原生通道为可选项；README-relay 补 TLS 部署一节
- 首帧鉴权：升级后首条消息 `{kind:'auth',token,role,connectionId}` 承载凭证（ws 帧不经反代访问日志）；query 双轨受理（老客户端兼容窗口，命中打弃用告警）；零凭证 5s 首帧窗超时 4001；四客户端构造点全部切换（URL 零凭证）；4001/4000 语义不变
- **升级注意**：新版客户端（桌面/无头/移动）需 relay 同步升级到批 I 版本（老 relay 只认 query 凭证会 4001 拒新客户端）；老客户端在双轨窗口内不受影响
- 随修两预存坏损：两共享包 tsconfig node10 在 TS 5.9.3 下拒编译（build 失败曾被管道 exit code 掩盖；0ad95c21 以 ignoreDeprecations=5.0 屏蔽，TS7 前需再迁移）；server `prisma/seed.ts` randomBytes 未 import

## 四、验证基线

三批收口时全绿：桌面 Vitest 4719 用例 + tsc/typecheck 干净；server 89 suite / 902 用例；mobile 714 用例 + tsc；relay 四链路 e2e 4/4（真 relay 子进程 + 双端真实握手栈 + 抓帧 proxy）；prettier 全过；drift 0 新增告警。

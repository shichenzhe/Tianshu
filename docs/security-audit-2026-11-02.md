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

## 三、剩余待办（3 项——均需 UI/依赖/协议层裁定）

### 1. 备份档口令加密

**现状**：备份档（tar.gz）内的凭证字段已加密（批三信封），但消息内容、技能等仍为明文；档文件本身无加密。

**方案**：导出 UI 增加口令输入 → scrypt 派生密钥 → AES-256-GCM 档级加密；恢复侧对应解密。`.jwt-secret` 已出档（恢复后自动轮换）。

**依赖**：桌面端导出/恢复 UI 配合（backup/ipc.ts + 设置面板）。

### 2. 移动端 relay 接入 e2e

**现状**：移动端 relay-transport 未实现 X25519 握手与 AES-GCM 信封——业务帧全明文过 relay（桌面端已实现，协议在 @tianshu/core e2e-crypto.ts 单源）。

**方案选型（需裁定）**：
- A. react-native-quick-crypto（原生模块，性能好，需 prebuild/Expo config plugin）
- B. 纯 JS 实现（tweetnacl-js X25519 + AES-GCM JS 填充，无原生依赖但性能受限）

**附带**：移动端连接 token 从 AsyncStorage 迁移 expo-secure-store（需安装依赖）。

**注意**：移动端未接 e2e 前，被控端默认不可收敛为全局 required（会断移动端连接）。

### 3. relay 原生 TLS + 凭证出 URL query

**现状**：relay 进程纯 node:http 无 TLS（批二已做控制端拒绝公网明文 ws://——域名与公网 IP 的 ws:// 保存被拒，loopback/私网 IP 放行）；token/connectionId 在 upgrade URL query。

**方案**：relay 增加 TLS 监听（证书配置面）；凭证改首帧鉴权或 header（wire 协议变更——需旧客户端兼容窗口）。

**依赖**：relay 部署面裁定（当前假设是反代终止 TLS；如需原生 TLS 需证书管理设计）。

## 四、验证基线

修复全程三端测试保持全绿：桌面 Vitest exit 0 + tsc 干净；server 89 suite / 892 用例；mobile 692 用例 + tsc；drift 55 对 0 告警。

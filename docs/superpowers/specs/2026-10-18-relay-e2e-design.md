# 天枢服务端二期：relay 端到端加密设计（零知识中继）

- 日期：2026-10-18
- 状态：已与用户对齐（X25519+HKDF+AEAD 信封/TOFU+指纹强制/降级兼容期；待入库）
- 前置：`2026-10-16-tianshu-server-design.md` §5（一期安全边界：token+TLS 半可信，NaCl 列二期）、`2026-10-17-shared-core-refactor-design.md`（core 包管道）
- 参照：paseo-relay 零知识语义（NaCl box、relay 只见 IP/时序/大小）；Node 原生 `node:crypto`（X25519/AES-256-GCM/HKDF）零新依赖

## 1. 背景与目标

relay 现为半可信（token 认证+上游 TLS）——运营方可读全部帧明文（聊天内容/文件路径/工具参数）。本设计使 relay 零知识化：控制端与被控端端到端加密，relay 仅转发密文。

**目标**：relay 承载的 req/res/event 全帧加密 + TOFU/指纹信任 + 兼容降级。
**非目标**：直连承载加密（localhost/上游 TLS 已覆盖，与 paseo 定位相同）；PQC；多方群发密钥；密钥轮换 UI（指纹重配即轮换）。

## 2. 密钥与协议

### 2.1 密钥模型

- 被控端**静态身份密钥对**（X25519）：option 表持久化（server-face 与 headless 各自 option）；设置面显示公钥（base64）与指纹（SHA-256 前 16 hex）供带外传递
- 控制端**每连接临时密钥对**（X25519，连接生命周期）
- 协商：X25519(临时, 静态私钥) → HKDF-SHA256 派生双向会话密钥（K_client→server / K_server→client 分向，附 connectionId/两公钥作 HKDF info 绑定）

### 2.2 握手帧（明文，relay 照转发）

- 控制端 → 被控端：`{kind:"e2e-hello", ephemeralKey, expectedFingerprint?}`（expectedFingerprint 为控制端已存指纹；空=TOFU）
- 被控端 → 控制端：`{kind:"e2e-ack", staticKey, fingerprint}`
- 校验：控制端持 expectedFingerprint 且不匹配 ack → **断开**（防中间人）；TOFU 时回显 ack 指纹（存储供后续强制）
- **hello 重放防护**：被控端忽略相同临时公钥的重复 hello（合法重协商恒新临时钥）——防重放字节相同 hello 重置会话重放窗导致既往密文 req 可重执行（终审 F1；epoch 内记忆）
- 之后全部业务帧（req/res/event/open/close 等）包装密文信封

### 2.3 密文信封

`{kind:"e2e-secure", n: <base64 12B nonce>, ct: <base64>}`——ct = AES-256-GCM(K_dir, n, aad=方向+帧序, plaintext=JSON 帧)。

- **nonce**：每方向 64 位计数器（初始随机 32 位前缀+计数器递增），接收端滑动窗口拒重放（窗口 64）
- **aad** 绑定方向与序号，防帧重排序注入；connectionId 不入 aad——经 HKDF info 层绑定（密钥派生即含，等价防跨连接/跨会话密文挪用）
- 帧大小：base64+信封实际膨胀 ~1.33×（nonce 12B+GCM tag 16B+base64 编码），有效明文上限 ~3.1MiB（relay maxPayload 4MiB）

### 2.4 降级语义（兼容期）

被控端对 e2e-hello 无回应（旧版）→ 控制端重试一次原 open 帧 → 明文承载 + 连接状态标注「未加密」（UI 警示徽标）；被控端配置 `relay.e2e: "required"`（默认 `auto`）时拒绝明文降级。控制端配置级开关同款（默认 auto）。

## 3. 实现面

### 3.1 加密核心（`@tianshu/core` 新模块 `src/e2e-crypto.ts`）

纯 node:crypto：密钥对生成/静态持久化序列化（由消费方存）/ECDH+HKDF 派生/信封 seal-open（计数器 nonce 与重放窗口状态机）/指纹计算。零 Electron、零第三方依赖。三方消费：mirror RelayTransport、server-face relay-client、headless relay-client（后者经 file: dist）。

### 3.2 被控端（mirror server-face + headless）

- 静态密钥 option 持久化（server-face option 键 `serverFace.e2eKey`；headless 自有 option 表）
- relay-client：role=server 握手处理（收到 e2e-hello → 回 e2e-ack → 后续帧 seal/open）；`relay.e2e` 模式（auto/required/off）
- headless 侧同构（`src/relay/relay-client.ts`）

### 3.3 控制端（mirror）

- RelayTransport：连接时生成临时对 → 发 e2e-hello（带已存指纹）→ ack 校验（不匹配断+状态 mitm-suspect）→ 密文承载；TOFU 存指纹进连接注册表
- 连接配置：`fingerprint?` 字段（增改连接对话框）；连接状态「未加密/加密（指纹匹配）」徽标
- 被控端设置卡：显示本机公钥+指纹+复制按钮；i18n 双语

## 4. 测试

- core 单测：往返/篡改拒/重放拒（窗口边界）/nonce 单调/降级明文路径/指纹稳定性
- mirror：RelayTransport 握手三态（匹配/TOFU/不匹配断）；relay-client 对偶；UI（指纹显示/徽标/i18n）
- E2E：本机 relay 全链路——控制端↔被控端密文往返 + **relay 侧 ws 抓帧断言无明文**（帧 payload 不含已知哨兵字符串）+ 降级路径（旧版模拟）+ 指纹不匹配断开

## 5. 安全边界

- E2E 仅 relay 承载；直连链路信任模型不变
- GCM nonce 计数器单连接单调——连接重建即新协商（新临时对+新派生），无 nonce 复用面
- 静态私钥持久化于各自 option 表（与既有 token 同级保护面）；指纹带外传递责任在用户（UI 引导）
- relay 被完全攻破：仅能断服务/观测时序大小/重放被拒帧——不能读写真控制端↔被控端信道内容。限定（单向认证）：被控端不认证对端身份，relay 持 token 可自建会话冒充控制端操作被控端业务面（一期 token 模型既有语义，指纹强制仅在控制端侧生效）；双向认证列后续批

## 6. 假设与偏离

1. AES-256-GCM 替代 XSalsa20-Poly1305（node:crypto 原生 vs tweetnacl 依赖——语义等价 AEAD）
2. 降级兼容期后（双端都升级）可把默认 auto 改 required（后续批一刀切）
3. headless 与被控桌面端各自独立静态密钥（同一被控端多入口场景指纹不同——按入口配置）
4. 指纹 UI 不做二维码（复制粘贴带外——后续可选）

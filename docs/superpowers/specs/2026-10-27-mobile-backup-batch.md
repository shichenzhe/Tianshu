# 移动端备份面批设计 spec

日期：2026-10-27
状态：spec 落盘（用户裁定「做」：触发+列表；恢复不做）
关联：desktop-backup-sync-batch-design（桌面备份链路）；automation/memory 批同套路

## 0. 事实基线

- **架构**：桌面端=备份客户端（backup-client 打包 tar.gz → direct 连接分块上传）；无头端=存储服务端（六端点 /backup/*，二层 BackupGuard：TIANSHU_BACKUP_TOKEN）。桌面 IPC 四通道（list/create/restore/delete）+ relaunch + backup:progress 事件（packing/uploading/downloading/restoring 四相字节进度），全部以桌面本地连接注册表的 connId 为参（仅 direct）。
- **face 零透出**；协议包 backup-contract 已有六端点 DTO（BackupMeta 等），无 FaceEvent/ENDPOINTS 面。

## 1. 本批裁定

1. **移动端 = 遥控桌面备份**（连无头端不进备份页——无头端是存储端非客户端；backup capability 仅 DESKTOP_CAPABILITIES 报）。
2. **face 三端点**（桌面被控面专属）：
   - `backup/list` {} → BackupMeta[]（代理拉桌面所配 direct 连接的无头端列表）
   - `backup/create` {note?} → **202 受理**：后台打包+上传（分钟级不可长连），进度与终态经事件流；connId 由桌面解析（注入 resolveConnection：连接注册表首个 direct；无 direct 业务错）
   - `backup/delete` {id} → 代理删除
3. **事件**：FaceEvent 增 `backup.progress`（BackupProgressPayload 收编协议包 + `done`/`error` 终态扩展帧——受理后完成/失败一帧收敛，移动端据此复位并重拉列表）；桌面 emit 函数并行扇出 face-events（与渲染窗广播同源）。
4. **桌面 IPC 收拢**：backup/ipc.ts create/list/delete 主体抽公开函数（IPC 与 face tap 同源——automation 批同款）；restore 不动（face 不透）。
5. **移动端 /backup 页**（「我的」入口，capability backup 门禁）：触发（note 可选）+ 四相进度条（packing/uploading）+ 列表（时间/大小/版本/note/deviceName/status 徽标）+ 行删除（Alert 确认）。
6. **不做**：恢复、relaunch、BACKUP_TOKEN 管理、无头端直连列表（连无头端不显示入口）。

## 2. 测试

- 协议：ENDPOINTS/backup 三段 + DESKTOP_CAPABILITIES + FaceEvent 断言（钉测试）。
- face：backup-tap 直测（connId 解析/未配 direct 错/list·delete 代理/create 202+终态帧）；routes.test 信封用例。
- mobile：store（进度帧→状态机/终态复位+重拉/防迟到）+ i18n 双语齐平。

## 3. 分提交

1. `feat(protocol)`：backup 三端点 + BackupProgressPayload（done/error 扩展）+ FaceEvent backup.progress + capability。
2. `feat(face)`：桌面 backup IPC 主体收拢公开 + emit 双扇出 + backup-tap + routes + 装配 + 测试。
3. `feat(mobile)`：transport + store（progress 订阅状态机）+ /backup 页 + 入口 + i18n + 测试；prettier 收口。

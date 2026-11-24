# 自动更新（GitHub Releases）

客户端自动更新源为 GitHub Releases（electron-updater 的 github provider），
真源配置在 `apps/tianshu-desktop/electron-builder.json5` 的 `publish`
（provider/owner/repo），打包时固化进 `resources/app-update.yml`，运行时
由 `electron/init-updater.ts` 原生读取——公开仓库无需任何 token。

## 1. 发版

打 `v*` tag 推送即可，CI（`.github/workflows/release.yml`）自动三平台
打安装包并把安装包 + `latest*.yml` 附到 GitHub Release。

- 版本号取自 `apps/tianshu-desktop/package.json`；electron-updater 按
  tag `v{version}` 匹配 Release（如 `0.2.0` → `v0.2.0`）。
- Release 必须为**正式发布态**：draft 会被 electron-updater 忽略，
  客户端检查结果为"无更新"。

## 2. 更新流程

客户端打包态启动即检查更新 → 检测到新版本自动下载 → 下载完成后提示
安装（渲染端"检查更新"菜单可手动触发）。开发态（`npm run dev`）不检查
更新，"检查更新"直接回发"无新版本"。

## 3. 注意事项

- 前提：仓库保持**公开**。转私有后匿名拉取 Release 失败，更新不可用
  （需另行引入 token 方案）。
- 匿名 GitHub API 限流 60 次/时/IP：频繁手动检查更新可能触发限流，
  走"更新错误"路径，属预期降级。
- 网络安全门豁免域已含更新流量域（`Constants.UPGRADE_HOSTS`：清单 API
  `api.github.com`、下载页 `github.com`、资产 CDN
  `release-assets.githubusercontent.com` 与旧域
  `objects.githubusercontent.com`——测试
  `tests/security/domain-policy.test.ts` 钉住清单），沙箱开启时不影响
  更新下载。注意豁免域对全部沙箱流量生效（不止更新请求）。

## 附注：generic 自建服务器（原模板用法，当前未启用）

任何静态文件托管（Nginx、对象存储、GitHub Releases 反代）均可作
generic 更新源：`electron-builder.json5` 的 `publish` 改回
`{ provider: "generic", url: "<地址>" }`，并在 `electron/init-updater.ts`
恢复 `autoUpdater.setFeedURL({ provider: "generic", url })` 与地址常量
（原 `Constants.UPGRADE_URL` 式写法）。每次 `npm run build` 后把
`release/<version>/` 整目录上传到服务器根路径，保持文件名不变。

Nginx 示例：

```nginx
server {
  listen 80;
  server_name updates.example.com;
  root /var/www/myapp-releases;
  # electron-updater 会请求 /latest.yml 与安装包
  add_header Cache-Control "no-cache";
}
```

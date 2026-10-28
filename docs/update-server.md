# 自建更新服务器

模板使用 electron-updater 的 **generic provider**：任何能托管静态文件的 HTTP 服务都可以
当更新服务器（Nginx、对象存储、GitHub Releases 反代均可）。

## 1. 配置地址

运行 `npm run init` 时填入更新服务器 URL（或直接改 `electron-builder.json5` 的
`publish.url` 与 `electron/Constants.ts` 的 `UPGRADE_URL`）。留空则自动更新禁用。

## 2. 发布流程

每次 `npm run build` 后，electron-builder 会在 `release/<version>/` 产出：

- 安装包（dmg / exe / AppImage）
- `latest.yml`（+ `latest-mac.yml` / `latest-linux.yml`）——版本清单

把**整个目录内容**上传到更新服务器根路径，保持文件名不变。客户端启动 5 秒后自动
检查更新，下载完成后提示安装。

## 3. Nginx 示例

```nginx
server {
  listen 80;
  server_name updates.example.com;
  root /var/www/myapp-releases;
  # electron-updater 会请求 /latest.yml 与安装包
  add_header Cache-Control "no-cache";
}
```

上传新版本即完成发布；版本号取自 `package.json`。

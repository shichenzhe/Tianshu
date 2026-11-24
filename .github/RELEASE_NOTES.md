# 安装说明

当前安装包未做代码签名与公证（无 Apple Developer 证书 / Windows 代码签名证书），首次安装时系统会拦截——**这不是文件损坏**，按下方步骤放行即可。

## macOS

从浏览器下载的 dmg 会带隔离标记，双击安装时可能提示「"天枢"已损坏，无法打开」。将应用拖入 `/Applications` 后，在终端执行一次：

```bash
xattr -rd com.apple.quarantine /Applications/天枢.app
```

（仅移除隔离标记，不改动系统安全设置；之后可正常启动。）

## Windows

运行安装包时 SmartScreen 可能提示「Windows 已保护你的电脑」：点击「更多信息」→「仍要运行」。

---

## 版本更新要点

- 见 [docs/update-log.md](../docs/update-log.md)

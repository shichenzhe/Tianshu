#!/bin/bash
# nativewind 本地树恢复脚本(99.9% 卡死修复的固化,2026-10-22)
#
# 根因:workspace hoist 后 nativewind 只在仓库根,withNativeWind 的自定义
# transformer(css-interop)在「mobile projectRoot + 根位置 nativewind」组合下
# 对带 transform.routerRoot 的请求(Expo Go 真机请求必带)死锁——真机永卡 99.9%。
# nativewind + react-native-css-interop 的实体必须在 apps/tianshu-mobile/node_modules。
#
# 触发时机:任何在仓库根执行的 `npm install`(含给 mobile 装新依赖)都可能把
# 本地 nativewind 重排回根——install 后若真机又卡 99.9%,重跑本脚本即可。
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

if [ -f "$APP_DIR/node_modules/nativewind/package.json" ]; then
  # 版本须与 package.json 声明一致(^range 兼容),陈旧则重拉(升级场景)
  MATCH="$(node -p "
    const declared = require('$APP_DIR/package.json').dependencies.nativewind || '*';
    const local = require('$APP_DIR/node_modules/nativewind/package.json').version;
    require('semver').satisfies(local, declared) ? 'yes' : 'no'
  " 2>/dev/null || echo yes)"
  if [ "$MATCH" = "yes" ]; then
    echo "nativewind 已在本地树且版本匹配,无需恢复"
    exit 0
  fi
  echo "本地 nativewind 版本陈旧,重新拉取..."
fi

echo "独立环境拉取 nativewind(版本以 mobile package.json 声明为准)..."
VERSION="$($APP_DIR/../../node_modules/.bin/node -p "require('$APP_DIR/package.json').dependencies.nativewind" 2>/dev/null || echo '^4.2.7')"
cd "$STAGE" && npm init -y >/dev/null 2>&1 && npm install "nativewind@$VERSION" --silent

cp -R "$STAGE/node_modules/nativewind" "$APP_DIR/node_modules/nativewind"
if [ -d "$STAGE/node_modules/react-native-css-interop" ]; then
  cp -R "$STAGE/node_modules/react-native-css-interop" "$APP_DIR/node_modules/react-native-css-interop"
fi

echo "已恢复:"
node -p "'  nativewind ' + require('$APP_DIR/node_modules/nativewind/package.json').version"
echo "重启 expo 前记得 --clear"

# tianshu-mobile

天枢移动端：Expo (React Native) 客户端，远控无头端 tianshu-server / 桌面端 mirror 的会话与审批。
三仓伴生：mirror（桌面端 + 协议/核心包）、tianshu-server（无头服务端）、tianshu-mobile（本仓）。
依赖 file: symlink 引 mirror 的 @tianshu/protocol，改协议包源码后须先重建其 dist。
启动：`npm install && npm run start`（iOS/Android 模拟器或 Expo Go）。

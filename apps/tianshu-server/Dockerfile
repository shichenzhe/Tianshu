# apps/tianshu-server/Dockerfile
# monorepo 根 context 构建（docker build -f apps/tianshu-server/Dockerfile .）：
# builder 全量 npm ci（lock 钉死）→ prisma generate（先于 build，TS 类型依赖）
# → 三包 build → 组装 vendor 内嵌 bundle（@tianshu/* → file:./vendors/*）。
# 六坑处置见 docs/superpowers/specs/2026-10-31-server-docker-deploy-design.md
# （坑 1「apk 工具链编过 node-pty」已随 --ignore-scripts 免编译整行移除，
# 见下 npm ci 注释；其余各坑处置不变）
FROM node:20.19.5-alpine3.22 AS builder
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/tianshu-protocol/package.json packages/tianshu-protocol/
COPY packages/tianshu-core/package.json packages/tianshu-core/
COPY apps/tianshu-server/package.json apps/tianshu-server/
# 镜像内 npm 10 无 allowScripts 门禁（那系宿主 npm 11 机制），脚本本会全跑；
# `npm ci --ignore-scripts` 连根 package.json postinstall 的
# `electron-builder install-app-deps` 一并免掉——否则 better-sqlite3 会按
# Electron 44 头文件源码重编（g++ 编不过 v8config.h）。本 builder 只需
# tsc + 声明文件 + prisma generate（显式 RUN 非 lifecycle；engine 是按需
# 下载的预编译二进制，非源码编译），node-pty/better-sqlite3 等原生重编
# 全不需要——apk python3/make/g++ 工具链行据此移除（原坑 1 处置由免脚本
# 取代）；bcrypt 等运行时原生依赖由 runner 层 npm ci（脚本照跑）装。
# ELECTRON_SKIP_BINARY_DOWNLOAD=1 保留作双保险：万一后人去掉
# --ignore-scripts，electron 二进制下载仍被显式跳过
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
# npmmirror 仅用于 lock 钉死的 ci（不做 semver 解析，无版本集差异风险）
RUN npm config set registry https://registry.npmmirror.com/ && npm ci --ignore-scripts
COPY packages packages
COPY apps/tianshu-server apps/tianshu-server
# prisma client 生成必须先于 nest build（DTO 引用生成枚举类型）。
# 双引擎（spec 2026-10-31）双 generate：SQLite 本尊（node_modules/.prisma）+
# 派生 PG 变体——derive 单源派生 schema → 独立 output src/generated/prisma-pg
# （PrismaService Proxy 门面运行时按 scheme require，postgres 态消费）。
# 派生与生成同在镜像内跑。注意 prisma 自定义 output 不清场：context 若随行
# 宿主（darwin/win）生成物，其平台 engine 二进制会残留混入镜像——先 rm 再
# 生成，产物 engine 仅 builder 平台（linux-musl，与 runner 同源）；root
# .dockerignore 另将 src/generated 挡在 context 外（双保险）
RUN cd apps/tianshu-server && npx prisma generate \
 && npm run prisma:pg:derive && rm -rf src/generated \
 && npx prisma generate --schema prisma/pg/schema.prisma
# 先清宿主随 context 带入的两包 dist（防陈旧产物顶替/误过产物闸）；
# tianshu-core 的 tsc 因 @langchain peer 存在 6 项既有类型报错而 exit 2
# ——host 侧同判（exit code 不作判据，Dockerfile.relay 已验证模式）：
# 构建允许失败但必须实际产出 dist/index.js，真失败（零产出）由产物存在
# 性闸住；server nest build 仍取全量 exit 0（消费 core dist 声明，不受
# 其源码类型报错波及）
RUN rm -rf packages/tianshu-core/dist packages/tianshu-protocol/dist \
 && npm --prefix packages/tianshu-protocol run build \
 && { npm --prefix packages/tianshu-core run build; [ -f packages/tianshu-core/dist/index.js ]; } \
 && npm run build -w apps/tianshu-server
# 组装 vendor 内嵌 bundle：@tianshu/* → file:./vendors/*（server 独立部署语义）。
# prisma CLI 原系 devDependencies，但运行时迁移要跑 `prisma migrate deploy`
# （migrate 体系批 T3 契约，db-url.ts），提升进 dependencies 并钉 builder 已装版本。
# @prisma/client 同随钉版：源声明是 ^6.9.0 范围，bundle lock 重解析可能取到
# 6.x 新运行时，与已拷贝的 6.19.3 .prisma 生成物错配——钉 builder 已装精确版本
#
# PG client 生成物（src/generated/prisma-pg）须显式拷贝进 dist 树：nest build
# 是 tsc（allowJs 关），纯 JS/.d.ts 产物不随编译进 dist；PrismaService 编译后
# 位于 dist/src/commons/database/，其 require('../../generated/prisma-pg')
# 解析到 dist/src/generated/prisma-pg——拷贝目标按此布局钉定（不是 /bundle/
# 顶层：dist/src/main.js 相对 require 不命中）。产物自含 runtime/ 与 engine
# 二进制（builder 平台生成，随 dir 整体拷贝即可用），schema.prisma 也在其中
# prisma 整树随行（migrate 体系批 T4）：runner 首启 `migrate deploy` 按 schema
# 同级目录解析 migrations——SQLite 用 prisma/migrations、PG 用 prisma/pg/
# migrations（db-url.ts 运行时契约同源），双端迁移随整目录 cp 一并入镜像、
# 无需单列 cp；dev 库 local.db 已被 root .dockerignore 的 **/local.db*
# 挡在 context 外，不会混入镜像
RUN mkdir -p /bundle/vendors/tianshu-protocol /bundle/vendors/tianshu-core \
 && cp -r packages/tianshu-protocol/dist /bundle/vendors/tianshu-protocol/ \
 && cp packages/tianshu-protocol/package.json /bundle/vendors/tianshu-protocol/ \
 && cp -r packages/tianshu-core/dist /bundle/vendors/tianshu-core/ \
 && cp packages/tianshu-core/package.json /bundle/vendors/tianshu-core/ \
 && cp -r apps/tianshu-server/dist /bundle/ \
 && cp -r apps/tianshu-server/src/generated /bundle/dist/src/ \
 && cp -r apps/tianshu-server/prisma /bundle/prisma \
 && node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('apps/tianshu-server/package.json','utf8'));for(const k of ['@tianshu/core','@tianshu/protocol'])p.dependencies[k]='file:./vendors/'+k.slice(1).replace('/','-');const ver=f=>{try{return JSON.parse(fs.readFileSync(f,'utf8')).version}catch(e){}};p.dependencies.prisma=ver('apps/tianshu-server/node_modules/prisma/package.json')||ver('node_modules/prisma/package.json')||p.devDependencies.prisma;p.dependencies['@prisma/client']=ver('apps/tianshu-server/node_modules/@prisma/client/package.json')||ver('node_modules/@prisma/client/package.json')||p.dependencies['@prisma/client'];delete p.devDependencies;fs.writeFileSync('/bundle/package.json',JSON.stringify(p,null,2))"
# bundle lock：官方源生成（semver 解析需官方版本集；npmmirror 有同步缺口），
# 随 bundle 交付 → runner 换 npm ci 确定性安装，lock 留镜像可审计。
# --registry 必须显式钉官方源：上面 npm config set 写入的是全局配置，跨层粘滞
RUN cd /bundle && npm install --package-lock-only --omit=dev --no-audit --no-fund --registry=https://registry.npmjs.org/

FROM node:20.19.5-alpine3.22 AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /bundle /app
RUN npm ci --omit=dev --no-audit --no-fund
# .prisma 生成物拷贝须在 install 之后（install 会重建 node_modules）；
# 源路径是 server 本地 node_modules（workspace 不提升；根下的是 postinstall
# 占位——--ignore-scripts 下连占位也不生成，本 Dockerfile 从不消费它）
COPY --from=builder /repo/apps/tianshu-server/node_modules/.prisma /app/node_modules/.prisma
EXPOSE 3000
CMD ["node","dist/src/main.js"]

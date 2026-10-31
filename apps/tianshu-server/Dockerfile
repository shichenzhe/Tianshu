# apps/tianshu-server/Dockerfile
# monorepo 根 context 构建（docker build -f apps/tianshu-server/Dockerfile .）：
# builder 全量 npm ci（lock 钉死）→ prisma generate（先于 build，TS 类型依赖）
# → 三包 build → 组装 vendor 内嵌 bundle（@tianshu/* → file:./vendors/*）。
# 六坑处置见 docs/superpowers/specs/2026-10-31-server-docker-deploy-design.md
FROM node:20.19.5-alpine3.22 AS builder
# node-pty musl arm64 无 prebuilt，需源码编译工具链（bcrypt 有 musl prebuilt）
RUN apk add --no-cache python3 make g++
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/tianshu-protocol/package.json packages/tianshu-protocol/
COPY packages/tianshu-core/package.json packages/tianshu-core/
COPY apps/tianshu-server/package.json apps/tianshu-server/
# 镜像内 npm 10 无 allowScripts 门禁（那系宿主 npm 11 机制），脚本全跑——
# electron 二进制经 ELECTRON_SKIP_BINARY_DOWNLOAD=1 显式跳过（官方支持
# 变量，省时且避 GitHub CDN 依赖）
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
# npmmirror 仅用于 lock 钉死的 ci（不做 semver 解析，无版本集差异风险）
RUN npm config set registry https://registry.npmmirror.com/ && npm ci
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
RUN npm --prefix packages/tianshu-protocol run build \
 && npm --prefix packages/tianshu-core run build \
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
# 源路径是 server 本地 node_modules（workspace 不提升；根下的是 postinstall 占位）
COPY --from=builder /repo/apps/tianshu-server/node_modules/.prisma /app/node_modules/.prisma
EXPOSE 3000
CMD ["node","dist/src/main.js"]

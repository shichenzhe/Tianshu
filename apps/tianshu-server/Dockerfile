# apps/tianshu-server/Dockerfile
# monorepo 根 context 构建（docker build -f apps/tianshu-server/Dockerfile .）：
# builder 全量 npm ci（lock 钉死）→ prisma generate（先于 build，TS 类型依赖）
# → 三包 build → 组装 vendor 内嵌 bundle（@tianshu/* → file:./vendors/*）。
# 六坑处置见 docs/superpowers/specs/2026-10-31-server-docker-deploy-design.md
FROM node:20.19.5-alpine3.22 AS builder
# node-pty musl arm64 无 prebuilt，需源码编译工具链（bcrypt 有 musl prebuilt；
# electron 二进制被根 allowScripts 白名单机制天然跳过）
RUN apk add --no-cache python3 make g++
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/tianshu-protocol/package.json packages/tianshu-protocol/
COPY packages/tianshu-core/package.json packages/tianshu-core/
COPY apps/tianshu-server/package.json apps/tianshu-server/
# npmmirror 仅用于 lock 钉死的 ci（不做 semver 解析，无版本集差异风险）
RUN npm config set registry https://registry.npmmirror.com/ && npm ci
COPY packages packages
COPY apps/tianshu-server apps/tianshu-server
# prisma client 生成必须先于 nest build（DTO 引用生成枚举类型）
RUN cd apps/tianshu-server && npx prisma generate
RUN npm --prefix packages/tianshu-protocol run build \
 && npm --prefix packages/tianshu-core run build \
 && npm run build -w apps/tianshu-server
# 组装 vendor 内嵌 bundle：@tianshu/* → file:./vendors/*（server 独立部署语义）。
# prisma CLI 原系 devDependencies，但运行时首启建库要跑 `prisma db push`
# （db-url.ts 的 prod 树契约），提升进 dependencies 并钉 builder 已装版本
RUN mkdir -p /bundle/vendors/tianshu-protocol /bundle/vendors/tianshu-core \
 && cp -r packages/tianshu-protocol/dist /bundle/vendors/tianshu-protocol/ \
 && cp packages/tianshu-protocol/package.json /bundle/vendors/tianshu-protocol/ \
 && cp -r packages/tianshu-core/dist /bundle/vendors/tianshu-core/ \
 && cp packages/tianshu-core/package.json /bundle/vendors/tianshu-core/ \
 && cp -r apps/tianshu-server/dist /bundle/ \
 && cp -r apps/tianshu-server/prisma /bundle/prisma \
 && node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('apps/tianshu-server/package.json','utf8'));for(const k of ['@tianshu/core','@tianshu/protocol'])p.dependencies[k]='file:./vendors/'+k.slice(1).replace('/','-');const ver=f=>{try{return JSON.parse(fs.readFileSync(f,'utf8')).version}catch(e){}};p.dependencies.prisma=ver('apps/tianshu-server/node_modules/prisma/package.json')||ver('node_modules/prisma/package.json')||p.devDependencies.prisma;delete p.devDependencies;fs.writeFileSync('/bundle/package.json',JSON.stringify(p,null,2))"
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

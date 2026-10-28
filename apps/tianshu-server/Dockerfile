FROM node:20.19.5-alpine3.22 AS builder

RUN mkdir -p /app
WORKDIR /app

COPY package*.json ./
RUN npm config set registry https://registry.npmmirror.com/
RUN npm ci

COPY . .
RUN npx prisma generate
RUN npm run build
RUN npm prune --omit=dev

FROM node:20.19.5-alpine3.22 AS runner
WORKDIR /app
ENV NODE_ENV=production

# Copy built artifacts and dependencies from builder
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

EXPOSE 3000

CMD ["node","dist/src/main.js"]

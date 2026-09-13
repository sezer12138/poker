# 同桌 · 德州扑克 —— 服务端镜像
#
# 这里没有构建步骤：Node 26 直接执行 .ts（类型剥离），所以镜像里只有源码和
# 运行时依赖。生产依赖只有 pg 一个，开发依赖（typescript、@types/*）不进镜像。
FROM node:26-alpine

ENV NODE_ENV=production

WORKDIR /app

# 先装依赖再拷源码，改业务代码不会让依赖层失效。
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 服务端与浏览器客户端必须保持同一相对布局：static.ts 按
# `apps/server/src/../../web/` 定位 apps/web，改写目录会让静态页 404。
COPY tsconfig.json ./
COPY packages ./packages
COPY apps ./apps

# 房间快照与会话表落在 POKER_DATA_DIR；以非 root 运行，只给它写这里。
RUN mkdir -p /app/data && chown -R node:node /app
USER node

VOLUME /app/data
EXPOSE 8787

ENV POKER_HOST=0.0.0.0 \
    POKER_PORT=8787 \
    POKER_DATA_DIR=/app/data

# 容器内自检：/api/health 不需要鉴权，能返回 200 就算活着。
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# SIGTERM 由 main.ts 接住：停止收新连接、打烊后退出（已升级的 WebSocket 也会被断开）。
CMD ["node", "apps/server/src/main.ts"]

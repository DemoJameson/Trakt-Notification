# ===================================================================
# 自托管部署（VPS / NAS / 群晖 / Railway / Fly.io 均可）
#
# 这是功能最完整、也是唯一**不依赖任何外部服务**的部署方式：
#   - 进程内定时器，1 分钟粒度，无外部依赖
#   - SQLite 文件存储（libSQL 指向本地文件），零外部服务
#   - 不依赖任何平台配额
#
# 没有构建阶段 —— 前端是 public/index.html，服务端靠 Node 22 的
# 类型擦除直接跑 TypeScript。所以镜像是「复制文件 + 启动」两步。
# 这样也就不存在「dist 忘了重新构建」这类部署事故。
#
# 构建：  docker build -t trakt-notification .
# 运行：  docker run -d --name trakt-notify \
#           -p 3000:3000 \
#           -v trakt-data:/app/data \
#           --env-file .env \
#           trakt-notification
# ===================================================================

# Node 22 才能用 --experimental-strip-types 直接跑 .ts。
# 类型擦除只支持「可擦除语法」：不能用 enum、namespace、构造器参数属性。
# 本项目已刻意全部避开这几种写法（见 tsconfig 与 AGENTS 说明）。
FROM node:22-alpine

WORKDIR /app

# 时区数据是**必需**的：提前/延后换算要靠 IANA 时区库解析 Asia/Shanghai
# 这类名称。alpine 默认不带 tzdata，缺了会让所有时间计算静默退化成 UTC。
RUN apk add --no-cache tzdata curl && \
    cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone

# 先只装依赖，利用层缓存：改代码不必重装 node_modules。
# 不加 --ignore-scripts：@libsql/client 的平台原生二进制需要正常安装流程，
# 跳过脚本会让它在运行时报「找不到模块」。
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# 源码 + 前端 + 脚本。src 是必须的（直接跑 .ts），public 是前端成品。
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY tsconfig.json ./

# SQLite 数据目录（务必挂载卷，否则重建容器会丢 token）
RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_DRIVER=libsql
ENV DATABASE_URL=file:/app/data/trakt.db
ENV TZ=Asia/Shanghai

EXPOSE 3000

# 容器内自带调度，无需外部 cron。
# 健康检查同时暴露"上次 tick 时间"，方便发现调度卡死。
# ⚠️ 不能只判 HTTP 200：/api/health 在"数据库连不上 / 表没建"时仍返回 200
#    （只有配置错误才 503），那样容器会被误判为健康。改为检查响应体里的
#    ready 字段（基础设施就绪）—— 它不把"还没登录 Trakt"这类设置态算作故障。
HEALTHCHECK --interval=60s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://localhost:3000/api/health | grep -q '"ready":true' || exit 1

CMD ["node", "--experimental-strip-types", "src/platform/node.ts"]

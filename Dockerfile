# ============================================================
# Stage 0: Shared Node.js base
# ============================================================
FROM hub.byted.org/codebase/ci_nodejs_20:latest AS base

ARG NODE_VERSION=22.18.0
ARG NODE_DIST_BASE=https://nodejs.org/dist

RUN ARCH="$(dpkg --print-architecture)" \
  && case "${ARCH}" in amd64) NODE_ARCH=x64 ;; arm64) NODE_ARCH=arm64 ;; *) exit 1 ;; esac \
  && curl -fsSL "${NODE_DIST_BASE}/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.gz" -o /tmp/node.tar.gz \
  && mkdir /tmp/node-dist \
  && tar -xzf /tmp/node.tar.gz -C /tmp/node-dist --strip-components=1 \
  && install /tmp/node-dist/bin/node /usr/local/bin/node \
  && rm -rf /tmp/node.tar.gz /tmp/node-dist \
  && node --version \
  && npm --version

WORKDIR /app

ENV TZ=Asia/Shanghai

# ============================================================
# Stage 1: Install dependencies and compile TypeScript
# ============================================================
FROM base AS builder

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ============================================================
# Stage 2: Install production dependencies only
# ============================================================
FROM base AS production-dependencies

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ============================================================
# Stage 3: Production runtime
# ============================================================
FROM base AS runner

ENV NODE_ENV=production
ENV APP_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3100

COPY --chown=1000:1000 --from=production-dependencies /app/node_modules ./node_modules
COPY --chown=1000:1000 --from=builder /app/dist ./dist
COPY --chown=1000:1000 package.json package-lock.json ./
COPY --chown=1000:1000 public ./public
COPY --chown=1000:1000 sql ./sql

USER 1000:1000

EXPOSE 3100

CMD ["node", "dist/main.js"]

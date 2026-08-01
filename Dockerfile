# ─────────────────────────────────────────────────────────────
#  IELTS CBT 模擬考試系統
#  多階段建置：先裝依賴，再把程式碼疊上去，讓改程式碼時能重用快取層
# ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps

WORKDIR /app
# bcryptjs / mysql2 都是純 JS，不需要編譯工具鏈
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund 2>/dev/null \
 || npm install --omit=dev --no-audit --no-fund


FROM node:22-alpine AS runtime

# tini 處理訊號，讓容器能正常收到 SIGTERM 優雅關機；curl 給 HEALTHCHECK 用
RUN apk add --no-cache tini curl tzdata \
 && cp /usr/share/zoneinfo/Asia/Taipei /etc/localtime \
 && echo "Asia/Taipei" > /etc/timezone

ENV NODE_ENV=production \
    PORT=3000 \
    UPLOAD_DIR=/data/uploads

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public
COPY samples ./samples
COPY test ./test
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh

RUN chmod +x /usr/local/bin/entrypoint.sh \
 && mkdir -p /data/uploads/audio /data/uploads/image /data/uploads/speaking \
 && chown -R node:node /data /app

USER node
EXPOSE 3000
VOLUME ["/data/uploads"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT}/api/health || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "server/index.js"]

#!/bin/sh
# ─────────────────────────────────────────────────────────────
#  容器啟動流程：建表／升級（內建等待資料庫）→ 可選匯入範例 → 啟動
#  等待邏輯寫在 server/db.js 的 waitForDb()，所以不需要額外裝 mysql client
# ─────────────────────────────────────────────────────────────
set -e

UPLOADS="${UPLOAD_DIR:-/data/uploads}"
mkdir -p "$UPLOADS/audio" "$UPLOADS/image" "$UPLOADS/speaking"

echo "→ 連線資料庫並建立／升級資料表…"
node server/scripts/initDb.js

# 第一次啟動時匯入範例試卷與示範帳號（在 .env 設 SEED_DEMO=1 才會做）
if [ "${SEED_DEMO}" = "1" ]; then
  echo "→ 匯入範例資料…"
  node server/scripts/seed.js || echo "  （範例資料已存在或匯入失敗，略過）"
fi

echo "→ 啟動伺服器"
exec "$@"

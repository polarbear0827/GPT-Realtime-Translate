#!/bin/zsh
# Deploys the audience-sharing relay (relay/) to your own Cloudflare account and prints the two values
# to paste into the app (分享 → 連接分享伺服器). Run it again after updating the app: the publish key is
# kept in relay/.publish-key and reused, so the app stays connected.
#
#   npm run relay:deploy
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RELAY_DIR="$ROOT_DIR/relay"
KEY_FILE="$RELAY_DIR/.publish-key"
cd "$RELAY_DIR"

if [[ ! -d node_modules ]]; then
  echo "安裝部署工具（wrangler）…"
  npm ci --no-audit --no-fund
fi

if ! npx wrangler whoami 2>&1 | grep -q "You are logged in"; then
  echo ""
  echo "需要登入 Cloudflare：瀏覽器會開啟登入頁，登入後按「Allow」授權，再回到這裡。"
  npx wrangler login
fi

# The publish key lets the app create rooms on this relay. It never leaves this computer except to
# Cloudflare (as a Worker secret) and the app.
if [[ ! -s "$KEY_FILE" ]]; then
  (umask 077 && print -r -- "kltp_$(openssl rand -base64 36 | tr '+/' '-_' | tr -d '=\n')" > "$KEY_FILE")
fi
KEY="$(tr -d '[:space:]' < "$KEY_FILE")"

SECRETS="$(mktemp)"
trap 'rm -f "$SECRETS"' EXIT
chmod 600 "$SECRETS"
print -r -- "PUBLISH_KEY=$KEY" > "$SECRETS"

echo ""
echo "部署到 Cloudflare…（第一次部署時，Cloudflare 可能會請你替 workers.dev 取一個子網域名稱）"
OUTPUT_FILE="$(mktemp)"
trap 'rm -f "$SECRETS" "$OUTPUT_FILE"' EXIT
npx wrangler deploy --secrets-file "$SECRETS" 2>&1 | tee "$OUTPUT_FILE"
URL="$(grep -Eo 'https://[A-Za-z0-9.-]+\.workers\.dev' "$OUTPUT_FILE" | head -1 || true)"
if [[ -z "$URL" ]]; then
  echo ""
  echo "部署完成，但沒有在輸出中找到 workers.dev 網址。請到 Cloudflare 後台 → Workers & Pages → klt-relay 查看網址。"
  echo "發佈金鑰：$KEY"
  exit 0
fi

# A new workers.dev name can take a little while to resolve.
echo ""
echo "確認分享伺服器可以使用…"
VERIFIED=""
for attempt in {1..20}; do
  if curl -fsS -m 10 -H "Authorization: Bearer $KEY" "$URL/api/verify" > /dev/null 2>&1; then
    VERIFIED=1
    break
  fi
  sleep 3
done

echo ""
echo "────────────────────────────────────────────────────────"
if [[ -n "$VERIFIED" ]]; then
  echo "✅ 分享伺服器已上線"
else
  echo "⚠️  已部署，但暫時還連不上（新網址有時需要幾分鐘生效）。稍後在 App 裡按「連接並驗證」即可。"
fi
echo ""
echo "  分享伺服器網址：$URL"
echo "  發佈金鑰：      $KEY"
echo ""
echo "到 App 按「分享」，貼上這兩個值，再按「連接並驗證」。"
echo "發佈金鑰存在 relay/.publish-key，請不要提交到 Git 或傳給別人。"
echo "────────────────────────────────────────────────────────"

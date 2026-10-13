#!/bin/zsh
# Deploys the audience-sharing relay (relay/) to your own Cloudflare account and connects the macOS app
# to it: the app asks "連接分享伺服器？" and you press 連接 — nothing to copy. Run it again after
# updating: the publish key is kept in relay/.publish-key and reused, so the app stays connected.
#
#   npm run relay:deploy     deploy (first time: log in to Cloudflare), then connect the app
#   npm run relay:connect    connect the app to the relay deployed earlier, without deploying
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RELAY_DIR="$ROOT_DIR/relay"
KEY_FILE="$RELAY_DIR/.publish-key"
URL_FILE="$RELAY_DIR/.relay-url"
cd "$RELAY_DIR"
# Wrangler can stop midway to ask about updating its "skills" for AI coding agents; that has nothing
# to do with deploying, so don't ask.
export WRANGLER_NO_SKILLS_UPDATE_PROMPTS=true

print_manual() {
  echo ""
  echo "  分享伺服器網址：$URL"
  echo "  發佈金鑰：      $(tr -d '[:space:]' < "$KEY_FILE")"
  echo ""
  echo "到 App 按「分享」→「手動輸入網址與發佈金鑰」，貼上這兩個值，再按「連接並驗證」。"
  echo "發佈金鑰存在 relay/.publish-key，請不要提交到 Git 或傳給別人。"
}

# The newest installed copy of the app that handles keynote-live-translator:// links (0.6.2 or later):
# /Applications, ~/Applications, anywhere Spotlight knows about, or this repository's build/ folder.
find_app() {
  local candidates=(
    "/Applications/Keynote Live Translator.app"
    "$HOME/Applications/Keynote Live Translator.app"
    ${(f)"$(mdfind "kMDItemCFBundleIdentifier == 'local.keynote-live-translator'" 2>/dev/null)"}
    "$ROOT_DIR"/build/v*/"Keynote Live Translator.app"(N)
  )
  local app plist version
  for app in $candidates; do
    plist="$app/Contents/Info.plist"
    [[ -f "$plist" ]] || continue
    [[ "$(/usr/libexec/PlistBuddy -c "Print :CFBundleURLTypes:0:CFBundleURLSchemes:0" "$plist" 2>/dev/null)" == "keynote-live-translator" ]] || continue
    version="$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$plist" 2>/dev/null || echo 0)"
    print -r -- "$version"$'\t'"$app"
  done | sort -t $'\t' -k1,1V | tail -1 | cut -f2
}

# Opens the app with a keynote-live-translator://share-setup link, so it connects without copying.
connect_app() {
  local app key encoded
  app="$(find_app)"
  if [[ -z "$app" ]]; then
    echo ""
    echo "沒有找到 0.6.2 以上版本的 Keynote Live Translator，所以沒辦法自動連接。"
    echo "安裝新版後執行 npm run relay:connect，或手動輸入："
    print_manual
    return 0
  fi
  key="$(tr -d '[:space:]' < "$KEY_FILE")"
  encoded="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$URL")"
  open -a "$app" "keynote-live-translator://share-setup?url=$encoded&key=$key"
  echo ""
  echo "✅ 已經把分享伺服器交給 App（$app）。"
  echo "   請在 App 跳出的「連接分享伺服器？」按「連接」。"
}

if [[ "${1:-}" == "--connect" ]]; then
  if [[ ! -s "$URL_FILE" || ! -s "$KEY_FILE" ]]; then
    echo "還沒有部署過分享伺服器，請先執行 npm run relay:deploy。" >&2
    exit 1
  fi
  URL="$(tr -d '[:space:]' < "$URL_FILE")"
  connect_app
  exit 0
fi

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
OUTPUT_FILE="$(mktemp)"
trap 'rm -f "$SECRETS" "$OUTPUT_FILE"' EXIT
chmod 600 "$SECRETS"
print -r -- "PUBLISH_KEY=$KEY" > "$SECRETS"

echo ""
echo "部署到 Cloudflare…（第一次部署時，Cloudflare 可能會請你替 workers.dev 取一個子網域名稱）"
npx wrangler deploy --secrets-file "$SECRETS" 2>&1 | tee "$OUTPUT_FILE"
URL="$(grep -Eo 'https://[A-Za-z0-9.-]+\.workers\.dev' "$OUTPUT_FILE" | head -1 || true)"
if [[ -z "$URL" ]]; then
  echo ""
  echo "部署完成，但沒有在輸出中找到 workers.dev 網址。請到 Cloudflare 後台 → Workers & Pages → klt-relay 查看網址。"
  exit 0
fi
print -r -- "$URL" > "$URL_FILE"

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
if [[ -z "$VERIFIED" ]]; then
  echo "⚠️  已部署，但暫時還連不上（新網址有時需要幾分鐘生效）。稍後執行 npm run relay:connect。"
  echo "  分享伺服器網址：$URL"
else
  echo "分享伺服器已上線：$URL"
  connect_app
fi
echo "────────────────────────────────────────────────────────"

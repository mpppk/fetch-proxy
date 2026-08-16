#!/usr/bin/env bash
#
# fetch-proxy のスモークテスト
#
# デプロイ済み Worker の主要エンドポイントを curl で叩き、HTTP ステータス
# (必要に応じてボディ/ヘッダ) を検証する。
#
# 使い方:
#   bash scripts/smoke.sh [BASE_URL]
#   bun run smoke [BASE_URL]
# BASE_URL 省略時は本番 (https://fetch.nibo.sh) を対象にする。
#
# 全チェック成功で exit 0、1つでも失敗すると exit 1。
set -uo pipefail

BASE_URL=""
for arg in "$@"; do
  case "$arg" in
    -*)
      echo "unknown option: $arg" >&2
      echo "usage: bash scripts/smoke.sh [BASE_URL]" >&2
      exit 2
      ;;
    *) BASE_URL="$arg" ;;
  esac
done
BASE_URL="${BASE_URL:-https://fetch.nibo.sh}"
BASE_URL="${BASE_URL%/}"

CURL_OPTS=(--silent --show-error --location --max-time 20 --retry 3 --retry-delay 2 --retry-connrefused)

pass=0
fail=0

check_status() {
  local method="$1" path="$2" want="$3" desc="${4:-}"
  local url="${BASE_URL}${path}"
  local got
  got="$(curl "${CURL_OPTS[@]}" -o /dev/null -w '%{http_code}' -X "$method" "$url" 2>/dev/null)"
  if [ "$got" = "$want" ]; then
    printf '  ok    %-4s %-45s %s\n' "$method" "$path" "$got"
    pass=$((pass + 1))
  else
    printf '  FAIL  %-4s %-45s want=%s got=%s %s\n' "$method" "$path" "$want" "$got" "$desc"
    fail=$((fail + 1))
  fi
}

check_body() {
  local method="$1" path="$2" want="$3" needle="$4"
  local url="${BASE_URL}${path}"
  local body code
  body="$(curl "${CURL_OPTS[@]}" -w '\n%{http_code}' -X "$method" "$url" 2>/dev/null)"
  code="${body##*$'\n'}"
  body="${body%$'\n'*}"
  if [ "$code" = "$want" ] && printf '%s' "$body" | grep -qF "$needle"; then
    printf '  ok    %-4s %-45s %s (contains %q)\n' "$method" "$path" "$code" "$needle"
    pass=$((pass + 1))
  else
    printf '  FAIL  %-4s %-45s want=%s got=%s (expected body contains %q)\n' \
      "$method" "$path" "$want" "$code" "$needle"
    fail=$((fail + 1))
  fi
}

check_header() {
  local method="$1" path="$2" want="$3" header="$4" needle="${5:-}"
  local url="${BASE_URL}${path}"
  local headers code
  headers="$(curl "${CURL_OPTS[@]}" -D - -o /dev/null -w '%{http_code}' -X "$method" "$url" 2>/dev/null)"
  code="${headers##*$'\n'}"
  if [ "$code" = "$want" ] && printf '%s' "$headers" | grep -iq "^${header}:"; then
    if [ -z "$needle" ] || printf '%s' "$headers" | grep -iF "$needle" >/dev/null; then
      printf '  ok    %-4s %-45s %s (%s)\n' "$method" "$path" "$code" "$header"
      pass=$((pass + 1))
      return
    fi
  fi
  printf '  FAIL  %-4s %-45s want=%s got=%s (expected header %s %s)\n' \
    "$method" "$path" "$want" "$code" "$header" "$needle"
  fail=$((fail + 1))
}

echo "Smoke test against: ${BASE_URL}"
echo

# --- Root ---
check_body GET / 200 "fetch-proxy"

# --- CORS preflight ---
check_header OPTIONS "/example.com/" 204 "Access-Control-Allow-Origin" "*"
check_status OPTIONS "/example.com/" 204

# --- Error handling ---
check_status GET "/" 200 # root with no target: help text (200) - note: GET / is help
# missing target on proxied root path is tested as GET / with no host -> 200 help, not 400
# But GET /?as=html should be 400 if as is present? Let's test proxy with invalid host
check_status GET "/invalid host" 400

# --- as parameter validation ---
check_body GET "/example.com/?as=invalid" 400 "invalid as value"

# --- Proxy: html (default) ---
# example.com is stable and returns "Example Domain"
check_body GET "/example.com/?as=html" 200 "Example Domain"
check_body GET "/example.com/" 200 "Example Domain"
check_header GET "/example.com/?as=html" 200 "Access-Control-Allow-Origin" "*"
check_header GET "/example.com/?as=html" 200 "Content-Type" "text/html"

# --- Proxy: meta ---
check_body GET "/example.com/?as=meta" 200 "Example Domain"
check_header GET "/example.com/?as=meta" 200 "Content-Type" "application/json"
check_header GET "/example.com/?as=meta" 200 "Access-Control-Allow-Origin" "*"

# --- Proxy: meta for YouTube (oEmbed) ---
# YouTube serves Workers a CAPTCHA interstitial instead of the watch page, so
# the title has to come from oEmbed. jNQXAC9IVRw is the oldest video on the site
# ("Me at the zoo"), about as unlikely to disappear as a YouTube URL gets.
check_body GET "/youtu.be/jNQXAC9IVRw?as=meta" 200 "Me at the zoo"
check_body GET "/www.youtube.com/watch?v=jNQXAC9IVRw&as=meta" 200 "Me at the zoo"

# --- as=title removed ---
check_body GET "/example.com/?as=title" 400 "as=title has been removed"

# --- Proxy: md ---
check_body GET "/example.com/?as=md" 200 "Example Domain"
check_header GET "/example.com/?as=md" 200 "Content-Type" "text/markdown"
check_header GET "/example.com/?as=md" 200 "Access-Control-Allow-Origin" "*"

# --- Query forwarding ---
check_body GET "/example.com/?as=meta" 200 "Example Domain"

# --- https:// prefix handling ---
check_body GET "/https://example.com/?as=meta" 200 "Example Domain"

# --- Method not allowed ---
check_status POST "/example.com/" 405

echo
echo "Result: ${pass} passed, ${fail} failed"
if [ "$fail" -ne 0 ]; then
  exit 1
fi

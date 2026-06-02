#!/usr/bin/env bash
set -euo pipefail

HOST="${HOST:-192.168.1.38}"
PORT="${PORT:-8090}"
API_KEY="${API_KEY:-${JARVIS_API_KEY:-}}"
TEXT="${TEXT:-Bonjour, ceci est un test de synthese vocale Jarvis en production.}"
ITERATIONS="${ITERATIONS:-3}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-90}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

if [[ -z "$API_KEY" ]] && [[ -f "${REPO_ROOT}/.env" ]]; then
  api_key_line="$(grep -E '^[[:space:]]*API_KEY=' "${REPO_ROOT}/.env" | tail -n 1 || true)"
  if [[ -n "$api_key_line" ]]; then
    API_KEY="${api_key_line#*=}"
  else
    api_keys_line="$(grep -E '^[[:space:]]*API_KEYS=' "${REPO_ROOT}/.env" | tail -n 1 || true)"
    if [[ -n "$api_keys_line" ]]; then
      API_KEY="${api_keys_line#*=}"
      API_KEY="${API_KEY%%,*}"
    fi
  fi
  API_KEY="${API_KEY%\"}"
  API_KEY="${API_KEY#\"}"
fi

if [[ -z "$API_KEY" ]]; then
  echo "API_KEY or JARVIS_API_KEY is required" >&2
  exit 1
fi

if ! [[ "$ITERATIONS" =~ ^[0-9]+$ ]] || [[ "$ITERATIONS" -lt 1 ]]; then
  echo "ITERATIONS must be a positive integer" >&2
  exit 1
fi

BASE_URL="http://${HOST}:${PORT}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

run_case() {
  local route="$1"
  local label="$2"
  local index provider status total starttransfer size download out_file headers_file metrics escaped_text

  echo ""
  echo "### ${label} (${route})"
  printf '%-6s | %-5s | %-22s | %-9s | %-9s | %-9s | %-8s\n' "run" "code" "provider" "total_ms" "ttfb_ms" "dl_ms" "bytes"
  printf '%s\n' "--------------------------------------------------------------------------------"

  for (( index=1; index<=ITERATIONS; index++ )); do
    out_file="${TMP_DIR}/${label// /_}-${index}.bin"
    headers_file="${TMP_DIR}/${label// /_}-${index}.headers"
    escaped_text="${TEXT//\"/\\\"}"

    metrics="$(curl -sS \
      -X POST "${BASE_URL}${route}" \
      -H "X-API-Key: ${API_KEY}" \
      -H "Content-Type: application/json" \
      -o "$out_file" \
      -D "$headers_file" \
      --max-time "$TIMEOUT_SECONDS" \
      --data "{\"text\":\"${escaped_text}\"}" \
      -w "%{http_code}|%{time_total}|%{time_starttransfer}|%{size_download}")"

    status="${metrics%%|*}"
    metrics="${metrics#*|}"
    total="${metrics%%|*}"
    metrics="${metrics#*|}"
    starttransfer="${metrics%%|*}"
    size="${metrics##*|}"
    provider="$(awk -F': ' 'tolower($1)=="x-tts-provider" {gsub("\r", "", $2); print $2}' "$headers_file" | tail -n 1)"
    provider="${provider:-n/a}"
    download="$(awk -v total="$total" -v ttfb="$starttransfer" 'BEGIN { printf "%.3f", (total - ttfb) }')"

    printf '%-6s | %-5s | %-22s | %-9s | %-9s | %-9s | %-8s\n' \
      "$index" \
      "$status" \
      "$provider" \
      "$(awk -v v="$total" 'BEGIN { printf "%.1f", v * 1000 }')" \
      "$(awk -v v="$starttransfer" 'BEGIN { printf "%.1f", v * 1000 }')" \
      "$(awk -v v="$download" 'BEGIN { printf "%.1f", v * 1000 }')" \
      "$size"
  done
}

echo "TTS benchmark target: ${BASE_URL}"
echo "Text length: ${#TEXT} chars"
echo "Iterations per route: ${ITERATIONS}"

run_case "/v1/tts" "auto"
run_case "/v1/tts/openai" "openai"
run_case "/v1/tts/ha" "ha"

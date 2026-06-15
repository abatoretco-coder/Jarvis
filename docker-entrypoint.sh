#!/bin/sh
set -eu

mkdir -p /app/data
chown -R node:node /app/data
chmod 700 /app/data
find /app/data -maxdepth 1 -type f \
  \( -name '*.json' -o -name '*.sqlite' -o -name '*.sqlite-shm' -o -name '*.sqlite-wal' \) \
  -exec chmod 600 {} +

umask 077
exec su-exec node "$@"

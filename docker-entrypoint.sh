#!/bin/sh
set -eu

mkdir -p /app/data
if [ ! -w /app/data ]; then
  echo "Jarvis data directory is not writable by the runtime user" >&2
  exit 1
fi

umask 077

exec "$@"

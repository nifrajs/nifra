#!/usr/bin/env sh
# Free SSR bench ports (4300–4337) and stop stray bench / meta-framework servers.
set -eu

for port in $(seq 4300 4359); do
  pids=$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "free :$port (pid $pids)"
    kill -9 $pids 2>/dev/null || true
  fi
done

pkill -f "bench/ssr/run.ts" 2>/dev/null || true
pkill -f "bench/ssr/.*/server" 2>/dev/null || true
pkill -f "solidstart/.output/server" 2>/dev/null || true
pkill -f "react-router-serve" 2>/dev/null || true

sleep 1
echo "ports 4300–4359 clear"

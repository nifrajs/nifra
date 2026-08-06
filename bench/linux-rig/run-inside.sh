#!/bin/bash
set -u
PORT=8817
GET_URL="http://127.0.0.1:$PORT/api/orders?limit=10"
POST_URL="http://127.0.0.1:$PORT/api/orders"
H1='authorization: Bearer abcdefghijklmnopqrstuvwxyz'
H2='cookie: theme=dark'
H3='origin: https://app.example.com'
BODY='{"sku":"SKU-1","qty":2,"note":"gift wrap"}'
cd /repo
bench() {
  local fw=$1 wl=$2
  if [ "$fw" = "nifra" ]; then
    taskset -c 0-3 node bench/http-realworld/dist/serve-node-nifra.js $PORT >/dev/null 2>&1 &
  else
    taskset -c 0-3 node bench/http-realworld/serve-node.ts "$fw" $PORT >/dev/null 2>&1 &
  fi
  SRV=$!
  for i in $(seq 1 80); do
    code=$(curl -s -o /dev/null -w '%{http_code}' -H "$H1" -H "$H2" -H "$H3" "$GET_URL" 2>/dev/null)
    [ "$code" = "200" ] && break; sleep 0.15
  done
  local out
  if [ "$wl" = "GET" ]; then
    taskset -c 4-11 oha -c 50 -z 1s --no-tui -H "$H1" -H "$H2" -H "$H3" "$GET_URL" >/dev/null 2>&1
    out=$(taskset -c 4-11 oha -c 50 -z 3s --no-tui -H "$H1" -H "$H2" -H "$H3" "$GET_URL" 2>/dev/null)
  else
    taskset -c 4-11 oha -c 50 -z 1s --no-tui -m POST -d "$BODY" -H 'content-type: application/json' -H "$H1" -H "$H2" -H "$H3" "$POST_URL" >/dev/null 2>&1
    out=$(taskset -c 4-11 oha -c 50 -z 3s --no-tui -m POST -d "$BODY" -H 'content-type: application/json' -H "$H1" -H "$H2" -H "$H3" "$POST_URL" 2>/dev/null)
  fi
  kill $SRV 2>/dev/null; wait $SRV 2>/dev/null; sleep 0.4
  out=$(echo "$out" | sed $'s/\x1b\[[0-9;]*m//g')
  local rps ok
  rps=$(echo "$out" | awk '/Requests\/sec:/ {printf "%.0f", $2}')
  ok=$(echo "$out" | awk '/Success rate:/ {print $3}')
  if [ "$ok" != "100.00%" ]; then echo "$fw $wl GATE-FAIL rate=$ok"; else echo "$fw $wl $rps"; fi
}
for wl in GET POST; do
  for fw in node-raw fastify nifra; do bench "$fw" "$wl"; done
  for fw in nifra fastify node-raw; do bench "$fw" "$wl"; done
done

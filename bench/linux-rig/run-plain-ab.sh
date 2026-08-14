#!/bin/bash
# Plain-server A/B on pinned cores: server 4-7, oha 8-15. Median of 3, interleaved, 100% gated.
# Asks whether the Node-stream hand-off costs the ORDINARY (non-proxy, non-static) path anything.
set -u
cd /repo
PORT=3630
BODY=/tmp/post-body.json
echo '{"name":"bench","note":"a-plain-request-body"}' > $BODY

run() { # $1 = bundle, $2 = route
  taskset -c 4-7 node "bench/proxy/dist/$1" $PORT >/dev/null 2>&1 &
  local SRV=$!
  local code=""
  for _ in $(seq 1 80); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/get" 2>/dev/null)
    [ "$code" = "200" ] && break
    sleep 0.15
  done
  if [ "$code" != "200" ]; then kill $SRV 2>/dev/null; echo "SPAWN-FAIL"; return; fi

  local args=("-c" "50" "--no-tui" "http://127.0.0.1:$PORT/$2")
  if [ "$2" = "post" ]; then
    args=("-c" "50" "--no-tui" "-m" "POST" "-H" "content-type: application/json" "-D" "$BODY" "http://127.0.0.1:$PORT/post")
  fi

  taskset -c 8-15 oha -z 1s "${args[@]}" >/dev/null 2>&1
  local out
  out=$(taskset -c 8-15 oha -z 4s "${args[@]}" 2>/dev/null | sed $'s/\x1b\[[0-9;]*m//g')
  kill $SRV 2>/dev/null; wait $SRV 2>/dev/null
  sleep 0.4
  local rate
  rate=$(echo "$out" | awk '/Success rate:/ {print $3}')
  if [ "$rate" != "100.00%" ]; then echo "GATE-FAIL"; else
    echo "$out" | awk '/Requests\/sec:/ {printf "%.0f", $2}'
  fi
}

RAW=$(mktemp)
for route in get post; do
  for pass in 1 2 3 4 5 6 7; do
    if [ $((pass % 2)) -eq 0 ]; then arms="plain-claim.js plain-baseline.js"
    else arms="plain-baseline.js plain-claim.js"; fi
    for a in $arms; do echo "$route ${a%.js} $(run "$a" "$route")" >> "$RAW"; done
  done
done

echo
for route in get post; do
  echo "### $route"
  awk -v r="$route" '$1==r { v[$2] = v[$2] " " $3 }
    END {
      for (k in v) {
        m = split(v[k], x, " ")
        bad=0; for (j=1;j<=m;j++) if (x[j]+0==0) bad=1
        if (bad) { printf "%-18s FAIL\n", k; continue }
        for (j=1;j<=m;j++) for (i=j+1;i<=m;i++) if (x[i]+0<x[j]+0) { t=x[j]; x[j]=x[i]; x[i]=t }
        printf "%-18s %d\n", k, x[int((m+1)/2)]
      }
    }' "$RAW"
done
echo
echo "raw:"; cat "$RAW"; rm -f "$RAW"
